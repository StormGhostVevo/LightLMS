import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { authRouter, usersRouter, sessionMiddleware, requireLogin, requireRole, jsonOnly } from "./auth.js";
import { mountCertificates } from "./certificates.js";
import { mountTheme } from "./theme.js";
import { mountImages, imageOf } from "./images.js";
import { mountEditing } from "./editing.js";
import { mountQuiz } from "./quiz.js";
import { mountCompletion, evaluateEveryone, evaluate, progress } from "./completion.js";
import { AiError, MIN_SOURCE, MAX_SOURCE, tidyDraft, plain } from "./ai.js";
import { TYPES, cleanQuestion, tidyQuestions, insertQuestion, toAdmin, forLearner } from "./questions.js";
import { now, bad, errorHandler } from "./http.js";

export function createApp({ db, config, ai }) {
  const app = express();
  app.set("trust proxy", config.trustProxy ?? 0); // see TRUST_PROXY in config.js
  app.use(helmet());
  // JSON bodies are small, except a cover image upload (base64 of up to 2 MB).
  const smallJson = express.json({ limit: "200kb" }),
    imageJson = express.json({ limit: "3.5mb" });
  app.use((req, res, next) =>
    (/^\/api\/admin\/courses\/\d+\/images?$/.test(req.path) && ["PUT", "POST"].includes(req.method)
      ? imageJson
      : smallJson)(req, res, next),
  );
  app.get("/health", (req, res) => res.json({ ok: true }));
  app.use("/api", jsonOnly, sessionMiddleware(db));
  // Someone on a temporary password can only use the sign-in and password routes until they choose their own.
  app.use("/api", (req, res, next) =>
    req.user?.must_change_password && !req.path.startsWith("/auth/")
      ? res.status(403).json({ error: "Choose a new password first", mustChangePassword: true })
      : next(),
  );
  app.use("/api/auth", authRouter({ db, config }));

  // ---- authoring (authors and admins) ----
  const admin = express.Router();
  admin.use(requireRole("author", "admin"));

  const aiLimit = rateLimit({
    windowMs: 10 * 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "That's a lot of AI requests. Try again in a few minutes." },
  });
  const needAi = (req, res, next) => (ai.name === "off" ? bad(res, "AI isn't switched on.", 503) : next());
  const course = id => db.prepare("SELECT * FROM courses WHERE id = ?").get(id);
  const touch = id => db.prepare("UPDATE courses SET updated_at = ? WHERE id = ?").run(now(), id);

  const insertLessons = (courseId, lessons) => {
    const ins = db.prepare("INSERT INTO lessons (course_id, position, title, body) VALUES (?, ?, ?, ?)");
    lessons.forEach((l, i) => ins.run(courseId, i, l.title, l.body));
  };
  const insertQuestions = (courseId, qs, source, start = 0) =>
    qs.forEach((q, i) => insertQuestion(db, courseId, start + i, q, source));

  admin.get("/ai/status", (req, res) =>
    res.json({ provider: ai.name, model: ai.model ?? null, sendsToThirdParty: !!ai.external }),
  );

  admin.get("/courses", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id, title, description, status, updated_at, image_key, image_alt FROM courses ORDER BY updated_at DESC",
        )
        .all()
        .map(({ image_key, image_alt, ...c }) => ({ ...c, image: imageOf({ image_key, image_alt }) })),
    ),
  );

  admin.get("/courses/:id", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const { image_key, image_alt, ...rest } = c;
    res.json({
      ...rest,
      image: imageOf(c),
      lessons: db
        .prepare("SELECT id, position, title, body FROM lessons WHERE course_id = ? ORDER BY position")
        .all(c.id),
      questions: db
        .prepare("SELECT * FROM questions WHERE course_id = ? ORDER BY position")
        .all(c.id)
        .map(toAdmin),
    });
  });

  // Draft a whole course (lessons plus draft questions) from pasted source material.
  admin.post("/ai/draft-course", needAi, aiLimit, async (req, res, next) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (text.length < MIN_SOURCE)
      return bad(res, "Add a bit more text first (at least a couple of sentences)");
    if (text.length > MAX_SOURCE) return bad(res, "That's too long for one draft. Split it up.");
    try {
      const d = tidyDraft(await ai.draftCourse({ text }));
      if (!d.lessons.length)
        return bad(res, "The AI didn't produce any lessons. Try different material.", 422);
      const id = db.transaction(() => {
        const t = now();
        const { lastInsertRowid } = db
          .prepare("INSERT INTO courses (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(d.title, d.description, t, t);
        insertLessons(lastInsertRowid, d.lessons);
        insertQuestions(lastInsertRowid, d.questions, "ai");
        return lastInsertRowid;
      })();
      res.status(201).json({ id, flags: d.flags });
    } catch (err) {
      err instanceof AiError ? bad(res, err.message, err.status) : next(err);
    }
  });

  // Generate more draft questions from a course's existing lessons.
  admin.post("/courses/:id/quiz/generate", needAi, aiLimit, async (req, res, next) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const lessons = db
      .prepare("SELECT title, body FROM lessons WHERE course_id = ? ORDER BY position")
      .all(c.id);
    if (!lessons.length) return bad(res, "Add a lesson first");
    const count = Math.min(10, Math.max(1, Number.parseInt(req.body?.count, 10) || 5));
    const types = req.body?.types === undefined ? ["mcq"] : req.body.types;
    if (!Array.isArray(types) || !types.length || types.some(t => !TYPES[t]))
      return bad(res, "Choose which question types to include");
    try {
      const flags = [];
      const made = await ai.generateQuiz({ lessons, count, types: [...new Set(types)] });
      flags.push(...(made.flags || []).map(plain).filter(Boolean).slice(0, 10)); // the AI's own "please check this" notes
      const qs = tidyQuestions(made.questions, flags);
      const start = db
        .prepare("SELECT COALESCE(MAX(position) + 1, 0) FROM questions WHERE course_id = ?")
        .pluck()
        .get(c.id);
      db.transaction(() => {
        insertQuestions(c.id, qs, "ai", start);
        touch(c.id);
      })();
      res.status(201).json({ added: qs.length, flags });
    } catch (err) {
      err instanceof AiError ? bad(res, err.message, err.status) : next(err);
    }
  });

  // Human review: approve, edit or delete a question. AI questions stay hidden from learners until approved.
  admin.patch("/questions/:id", (req, res) => {
    const q = db.prepare("SELECT * FROM questions WHERE id = ?").get(req.params.id);
    if (!q) return bad(res, "Question not found", 404);
    const b = req.body || {};
    const status = b.status === undefined ? q.status : b.status;
    if (!["draft", "approved"].includes(status)) return bad(res, "Status must be draft or approved");
    // Fields that are sent replace the question's; the rest stay as they were. Changing the type needs everything the new type requires.
    const fields = [
      "type",
      "prompt",
      "options",
      "answer",
      "answers",
      "accepted",
      "value",
      "tolerance",
      "pairs",
      "explanation",
    ];
    const fixed = cleanQuestion({
      ...toAdmin(q),
      ...Object.fromEntries(fields.filter(f => b[f] !== undefined).map(f => [f, b[f]])),
    });
    if (fixed.error) return bad(res, fixed.error);
    const v = fixed.value;
    db.prepare(
      "UPDATE questions SET type = ?, prompt = ?, options = ?, answer = ?, spec = ?, explanation = ?, status = ? WHERE id = ?",
    ).run(
      v.type,
      v.prompt,
      JSON.stringify(v.options),
      v.answer,
      JSON.stringify(v.spec),
      v.explanation,
      status,
      q.id,
    );
    touch(q.course_id);
    evaluateEveryone(db, course(q.course_id)); // approving or unapproving changes whether the course has a quiz
    res.json(toAdmin(db.prepare("SELECT * FROM questions WHERE id = ?").get(q.id)));
  });

  admin.delete("/questions/:id", (req, res) => {
    const q = db.prepare("SELECT course_id FROM questions WHERE id = ?").get(req.params.id);
    if (!q) return bad(res, "Question not found", 404);
    db.prepare("DELETE FROM questions WHERE id = ?").run(req.params.id);
    touch(q.course_id);
    evaluateEveryone(db, course(q.course_id));
    res.status(204).end();
  });

  // Title, description and who may enrol.
  admin.patch("/courses/:id", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const b = req.body || {};
    const title = b.title === undefined ? c.title : plain(b.title).slice(0, 200);
    const description = b.description === undefined ? c.description : plain(b.description).slice(0, 1000);
    const enrolment = b.enrolment ?? c.enrolment;
    if (!title) return bad(res, "A course needs a title");
    if (!["manual", "open"].includes(enrolment)) return bad(res, "Enrolment must be manual or open");
    const passMark = b.passMark ?? c.pass_mark;
    if (!Number.isInteger(passMark) || passMark < 0 || passMark > 100)
      return bad(res, "Pass mark must be a whole number from 0 to 100");
    const maxAttempts = b.maxAttempts === undefined ? c.max_attempts : b.maxAttempts; // null = unlimited
    if (maxAttempts !== null && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50))
      return bad(res, "Max attempts must be 1 to 50, or null for unlimited");
    const certificate =
      b.certificate === undefined
        ? c.certificate_enabled
        : typeof b.certificate === "boolean"
          ? Number(b.certificate)
          : null;
    if (certificate === null) return bad(res, "certificate must be true or false");
    const completion = b.completion ?? c.completion_rule;
    if (!["lessons", "quiz", "both"].includes(completion))
      return bad(res, "completion must be lessons, quiz or both");
    const showAnswers = b.showAnswers ?? c.show_answers;
    if (!["never", "after_pass", "always"].includes(showAnswers))
      return bad(res, "showAnswers must be never, after_pass or always");
    db.prepare(
      "UPDATE courses SET title = ?, description = ?, enrolment = ?, pass_mark = ?, max_attempts = ?, show_answers = ?, completion_rule = ?, certificate_enabled = ?, updated_at = ? WHERE id = ?",
    ).run(
      title,
      description,
      enrolment,
      passMark,
      maxAttempts,
      showAnswers,
      completion,
      certificate,
      now(),
      c.id,
    );
    // A looser rule can complete people who already meet it. Completions already earned are never taken back.
    if (completion !== c.completion_rule) evaluateEveryone(db, course(c.id));
    res.json({
      id: c.id,
      title,
      description,
      enrolment,
      passMark,
      maxAttempts,
      showAnswers,
      completion,
      certificate: !!certificate,
    });
  });

  admin.get("/courses/:id/enrolments", (req, res) => {
    if (!course(req.params.id)) return bad(res, "Course not found", 404);
    res.json(
      db
        .prepare(
          `SELECT u.id, u.email, u.name, u.role, e.enrolled_at, e.enrolled_by IS NULL AS self_enrolled FROM enrolments e
                         JOIN users u ON u.id = e.user_id WHERE e.course_id = ? ORDER BY u.email`,
        )
        .all(req.params.id)
        .map(r => ({ ...r, self_enrolled: !!r.self_enrolled })),
    );
  });

  // Body: { emails: [...] }. Unknown or inactive emails are reported back, never silently skipped.
  admin.post("/courses/:id/enrolments", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const emails = req.body?.emails;
    if (
      !Array.isArray(emails) ||
      !emails.length ||
      emails.length > 500 ||
      emails.some(e => typeof e !== "string")
    )
      return bad(res, "Send up to 500 email addresses as { emails: [...] }");
    const out = { enrolled: [], alreadyEnrolled: [], notFound: [] };
    const find = db.prepare("SELECT id FROM users WHERE email = ? AND active = 1");
    const ins = db.prepare(
      "INSERT OR IGNORE INTO enrolments (course_id, user_id, enrolled_at, enrolled_by) VALUES (?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (const email of [...new Set(emails.map(e => e.trim().toLowerCase()))]) {
        const u = find.get(email);
        if (!u) out.notFound.push(email);
        else
          (ins.run(c.id, u.id, now(), req.user.id).changes ? out.enrolled : out.alreadyEnrolled).push(email);
      }
    })();
    res.json(out);
  });

  admin.delete("/courses/:id/enrolments/:userId", (req, res) => {
    const r = db
      .prepare("DELETE FROM enrolments WHERE course_id = ? AND user_id = ?")
      .run(req.params.id, req.params.userId);
    r.changes ? res.status(204).end() : bad(res, "That person isn't enrolled", 404);
  });

  admin.post("/courses/:id/publish", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    if (!db.prepare("SELECT COUNT(*) FROM lessons WHERE course_id = ?").pluck().get(c.id))
      return bad(res, "Add at least one lesson first");
    db.prepare("UPDATE courses SET status = 'published', updated_at = ? WHERE id = ?").run(now(), c.id);
    res.json({ id: c.id, status: "published" });
  });

  mountEditing({ admin, db, course, touch, evaluateEveryone });
  mountImages({ app, admin, db, course, touch });
  mountTheme({ app, db, requireRole });
  app.use("/api/admin/users", requireRole("admin"), usersRouter({ db }));
  app.use("/api/admin", admin);

  // ---- learner (signed in; published courses only; correct answers never leave the server) ----
  const isStaff = u => u.role === "author" || u.role === "admin";
  const enrolled = (courseId, userId) =>
    !!db.prepare("SELECT 1 FROM enrolments WHERE course_id = ? AND user_id = ?").get(courseId, userId);
  // A published course the person may read: enrolled, or staff previewing. Anything else looks like it doesn't exist.
  const visible = (req, res) => {
    const c = course(req.params.id);
    if (!c || c.status !== "published" || !(enrolled(c.id, req.user.id) || isStaff(req.user))) {
      bad(res, "Course not found", 404);
      return null;
    }
    return c;
  };

  // My courses.
  app.get("/api/courses", requireLogin, (req, res) =>
    res.json(
      db
        .prepare(
          `SELECT c.* FROM courses c JOIN enrolments e ON e.course_id = c.id
                         WHERE c.status = 'published' AND e.user_id = ? ORDER BY c.title`,
        )
        .all(req.user.id)
        .map(c => {
          const p = progress(db, c, req.user.id);
          return {
            id: c.id,
            title: c.title,
            description: c.description,
            image: imageOf(c),
            percent: p.percent,
            completed: p.completed,
          };
        }),
    ),
  );

  // Open courses I could join.
  app.get("/api/courses/available", requireLogin, (req, res) =>
    res.json(
      db
        .prepare(
          `SELECT id, title, description, image_key, image_alt FROM courses WHERE status = 'published' AND enrolment = 'open'
                         AND id NOT IN (SELECT course_id FROM enrolments WHERE user_id = ?) ORDER BY title`,
        )
        .all(req.user.id)
        .map(({ image_key, image_alt, ...c }) => ({ ...c, image: imageOf({ image_key, image_alt }) })),
    ),
  );

  app.post("/api/courses/:id/enrol", requireLogin, (req, res) => {
    const c = course(req.params.id);
    if (!c || c.status !== "published" || c.enrolment !== "open")
      return bad(res, "That course isn't open for self-enrolment", 404);
    db.prepare(
      "INSERT OR IGNORE INTO enrolments (course_id, user_id, enrolled_at, enrolled_by) VALUES (?, ?, ?, NULL)",
    ).run(c.id, req.user.id, now());
    res.status(201).json({ id: c.id, enrolled: true });
  });

  app.get("/api/courses/:id", requireLogin, (req, res) => {
    const c = visible(req, res);
    if (!c) return;
    res.json({
      id: c.id,
      title: c.title,
      description: c.description,
      image: imageOf(c),
      passMark: c.pass_mark,
      maxAttempts: c.max_attempts,
      lessons: db
        .prepare("SELECT id, title, body FROM lessons WHERE course_id = ? ORDER BY position")
        .all(c.id),
      questions: db
        .prepare("SELECT * FROM questions WHERE course_id = ? AND status = 'approved' ORDER BY position")
        .all(c.id)
        .map(forLearner),
    });
  });

  mountQuiz({ app, admin, db, course, visible, enrolled, requireLogin, evaluate });
  mountCompletion({ app, db, visible, enrolled, requireLogin });
  mountCertificates({ app, admin, db, config, course, visible, requireLogin });

  app.use("/", express.static(new URL("../public", import.meta.url).pathname));

  app.use(errorHandler);
  return app;
}
