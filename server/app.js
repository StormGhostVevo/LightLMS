import { readFileSync } from "node:fs";
import express from "express";
import helmet from "helmet";
import { errorHandler } from "./http.js";
import { createLogger, requestLogger } from "./logger.js";
import { createEvents } from "./events.js";
import { registerAudit, mountAudit } from "./audit.js";
import { authRouter, usersRouter, sessionMiddleware, requireLogin, jsonOnly } from "./auth.js";
import { requireCapability, adminGuard } from "./permissions.js";
import { createCourses } from "./services/courses.js";
import { createEnrolment } from "./services/enrolment.js";
import { createQuestionAdmin } from "./services/question-admin.js";
import { createAiAuthoring } from "./services/ai-authoring.js";
import { mountAdminCourses } from "./routes/admin-courses.js";
import { mountAdminBackups } from "./routes/admin-backups.js";
import { mountLearner } from "./routes/learner.js";
import { mountEditing } from "./editing.js";
import { mountImages } from "./images.js";
import { mountTheme } from "./theme.js";
import { mountQuiz } from "./quiz.js";
import { mountCompletion, evaluateEveryone, evaluate } from "./completion.js";
import { mountCertificates } from "./certificates.js";

/**
 * Builds the whole server. This file only wires things together; the rules live in the services, the routes
 * in the route files, and who may do what in permissions.js.
 * @param {{ db: import("better-sqlite3").Database, config: any, ai: any, log?: import("./logger.js").Logger }} deps
 */
export function createApp({ db, config, ai, log = createLogger({ level: config.logLevel ?? "silent" }) }) {
  // ---- things the routes share ----
  const events = createEvents({ log });
  registerAudit({ db, events });
  const courses = createCourses(db);
  const enrolment = createEnrolment(db);
  const questionAdmin = createQuestionAdmin(db, courses);
  const aiAuthoring = createAiAuthoring(db, ai, courses);

  // ---- the request pipeline ----
  const app = express();
  app.set("trust proxy", config.trustProxy ?? 0); // see TRUST_PROXY in config.js
  app.use(requestLogger(log));
  app.use(helmet());
  // JSON bodies are small, except a cover image upload (base64 of up to 2 MB).
  const smallJson = express.json({ limit: "200kb" });
  const imageJson = express.json({ limit: "3.5mb" });
  app.use((req, res, next) => {
    const isImageUpload =
      /^\/api\/admin\/courses\/\d+\/images?$/.test(req.path) && ["PUT", "POST"].includes(req.method);
    return (isImageUpload ? imageJson : smallJson)(req, res, next);
  });
  // For uptime checks and deploys: is the process up, can it reach its database, and which version and schema is it running?
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  app.get("/health", (req, res) => {
    try {
      const schema = db
        .prepare("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1")
        .pluck()
        .get();
      res.json({ ok: true, version, schema });
    } catch (err) {
      log.error("health check failed", { err });
      res.status(503).json({ ok: false });
    }
  });
  app.use("/api", jsonOnly, sessionMiddleware(db));
  // Someone on a temporary password can only use the sign-in and password routes until they choose their own.
  app.use("/api", (req, res, next) =>
    req.user?.must_change_password && !req.path.startsWith("/auth/")
      ? res.status(403).json({ error: "Choose a new password first", mustChangePassword: true })
      : next(),
  );
  app.use("/api/auth", authRouter({ db, config, events }));

  // ---- staff (everything under /api/admin goes through adminGuard, which checks permissions.js) ----
  const admin = express.Router();
  admin.use(adminGuard);
  mountAdminCourses({ admin, courses, enrolment, questionAdmin, aiAuthoring, ai, events });
  mountEditing({ admin, db, course: courses.get, touch: courses.touch, evaluateEveryone, events });
  mountImages({ app, admin, db, course: courses.get, touch: courses.touch });
  mountAudit({ admin, db });
  mountAdminBackups({ admin, db, config, events });
  mountTheme({ app, db, requireCapability, events });
  app.use("/api/admin/users", requireCapability("user:manage"), usersRouter({ db, events }));

  // ---- learners (signed in; published courses only) ----
  const { visible } = mountLearner({ app, courses, enrolment, requireLogin });
  const common = {
    app,
    admin,
    db,
    course: courses.get,
    visible,
    enrolled: enrolment.isEnrolled,
    requireLogin,
  };
  mountQuiz({ ...common, evaluate });
  mountCompletion(common);
  mountCertificates({ ...common, config, events });

  app.use("/api/admin", admin);
  app.use("/", express.static(new URL("../public", import.meta.url).pathname));
  app.use(errorHandler(log));
  app.locals.adminRouter = admin; // lets the tests check that every admin route has a listed capability
  return app;
}
