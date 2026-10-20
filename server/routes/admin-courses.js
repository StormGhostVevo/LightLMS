import { rateLimit } from "express-rate-limit";
import { bad } from "../http.js";
import { target } from "../events.js";

/**
 * Staff routes for courses: reading, settings, publishing, enrolment, question review and the AI.
 * They hold no rules of their own: the services do the work and throw errors that people can read.
 */
export function mountAdminCourses({ admin, courses, enrolment, questionAdmin, aiAuthoring, ai, events }) {
  const aiLimit = rateLimit({
    windowMs: 10 * 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "That's a lot of AI requests. Try again in a few minutes." },
  });
  const needAi = (req, res, next) => (ai.name === "off" ? bad(res, "AI isn't switched on.", 503) : next());
  const about = c => target("course", c.id, c.title);

  admin.get("/ai/status", (req, res) =>
    res.json({ provider: ai.name, model: ai.model ?? null, sendsToThirdParty: !!ai.external }),
  );

  admin.get("/courses", (req, res) => res.json(courses.adminList()));
  admin.get("/courses/:id", (req, res) => res.json(courses.adminDetail(courses.need(req.params.id))));

  // ---- the AI ----
  admin.post("/ai/draft-course", needAi, aiLimit, async (req, res) => {
    const r = await aiAuthoring.draftCourse(req.body?.text);
    events.emit("ai.course_drafted", {
      actor: req.user,
      target: target("course", r.id, r.title),
      detail: { lessons: r.lessons, questions: r.questions },
    });
    res.status(201).json({ id: r.id, flags: r.flags });
  });

  admin.post("/courses/:id/quiz/generate", needAi, aiLimit, async (req, res) => {
    const c = courses.need(req.params.id);
    const r = await aiAuthoring.generateQuiz(c, req.body?.count, req.body?.types);
    events.emit("ai.quiz_generated", {
      actor: req.user,
      target: about(c),
      detail: { added: r.added, types: r.types },
    });
    res.status(201).json({ added: r.added, flags: r.flags });
  });

  // ---- question review ----
  admin.patch("/questions/:id", (req, res) => res.json(questionAdmin.update(req.params.id, req.body || {})));
  admin.delete("/questions/:id", (req, res) => {
    questionAdmin.remove(req.params.id);
    res.status(204).end();
  });

  // ---- settings and status ----
  admin.patch("/courses/:id", (req, res) => {
    const c = courses.need(req.params.id);
    const { settings, changed } = courses.updateSettings(c, req.body || {});
    if (Object.keys(changed).length)
      events.emit("course.settings_changed", {
        actor: req.user,
        target: target("course", c.id, settings.title),
        detail: changed,
      });
    res.json(settings);
  });

  admin.post("/courses/:id/publish", (req, res) => {
    const c = courses.need(req.params.id);
    courses.publish(c);
    events.emit("course.published", { actor: req.user, target: about(c) });
    res.json({ id: c.id, status: "published" });
  });

  // ---- enrolment ----
  admin.get("/courses/:id/enrolments", (req, res) => {
    courses.need(req.params.id);
    res.json(enrolment.list(req.params.id));
  });

  admin.post("/courses/:id/enrolments", (req, res) => {
    const c = courses.need(req.params.id);
    const out = enrolment.enrolEmails(c, req.body?.emails, req.user.id);
    if (out.enrolled.length)
      events.emit("enrolment.added", {
        actor: req.user,
        target: about(c),
        detail: { people: out.enrolled.length },
      });
    res.json(out);
  });

  admin.delete("/courses/:id/enrolments/:userId", (req, res) => {
    const c = courses.need(req.params.id);
    const person = enrolment.unenrol(c.id, req.params.userId);
    events.emit("enrolment.removed", { actor: req.user, target: about(c), detail: { person } });
    res.status(204).end();
  });
}
