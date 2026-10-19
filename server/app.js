import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import { AiError, MIN_SOURCE, MAX_SOURCE, tidyDraft, tidyQuestions, plain } from "./ai.js";

const now = () => new Date().toISOString();
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const toQuestion = r => ({ id: r.id, prompt: r.prompt, options: JSON.parse(r.options), answer: r.answer, explanation: r.explanation, source: r.source, status: r.status });

function sameToken(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp({ db, config, ai }) {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "200kb" }));
  app.get("/health", (req, res) => res.json({ ok: true }));

  // ---- authoring (staff token) ----
  const admin = express.Router();
  admin.use((req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    return m && config.adminToken && sameToken(m[1], config.adminToken) ? next() : bad(res, "Not authorised", 401);
  });

  const aiLimit = rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
    message: { error: "That's a lot of AI requests. Try again in a few minutes." } });
  const needAi = (req, res, next) => (ai.name === "off" ? bad(res, "AI isn't switched on.", 503) : next());
  const course = id => db.prepare("SELECT * FROM courses WHERE id = ?").get(id);
  const touch = id => db.prepare("UPDATE courses SET updated_at = ? WHERE id = ?").run(now(), id);

  const insertLessons = (courseId, lessons) => {
    const ins = db.prepare("INSERT INTO lessons (course_id, position, title, body) VALUES (?, ?, ?, ?)");
    lessons.forEach((l, i) => ins.run(courseId, i, l.title, l.body));
  };
  const insertQuestions = (courseId, qs, source, start = 0) => {
    const ins = db.prepare("INSERT INTO questions (course_id, position, prompt, options, answer, explanation, source) VALUES (?, ?, ?, ?, ?, ?, ?)");
    qs.forEach((q, i) => ins.run(courseId, start + i, q.prompt, JSON.stringify(q.options), q.answer, q.explanation, source));
  };

  admin.get("/ai/status", (req, res) => res.json({ provider: ai.name, model: ai.model ?? null, sendsToThirdParty: !!ai.external }));

  admin.get("/courses", (req, res) => res.json(db.prepare("SELECT id, title, description, status, updated_at FROM courses ORDER BY updated_at DESC").all()));

  admin.get("/courses/:id", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    res.json({ ...c,
      lessons: db.prepare("SELECT id, position, title, body FROM lessons WHERE course_id = ? ORDER BY position").all(c.id),
      questions: db.prepare("SELECT * FROM questions WHERE course_id = ? ORDER BY position").all(c.id).map(toQuestion) });
  });

  // Draft a whole course (lessons plus draft questions) from pasted source material.
  admin.post("/ai/draft-course", needAi, aiLimit, async (req, res, next) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (text.length < MIN_SOURCE) return bad(res, "Add a bit more text first (at least a couple of sentences)");
    if (text.length > MAX_SOURCE) return bad(res, "That's too long for one draft. Split it up.");
    try {
      const d = tidyDraft(await ai.draftCourse({ text }));
      if (!d.lessons.length) return bad(res, "The AI didn't produce any lessons. Try different material.", 422);
      const id = db.transaction(() => {
        const t = now();
        const { lastInsertRowid } = db.prepare("INSERT INTO courses (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)").run(d.title, d.description, t, t);
        insertLessons(lastInsertRowid, d.lessons);
        insertQuestions(lastInsertRowid, d.questions, "ai");
        return lastInsertRowid;
      })();
      res.status(201).json({ id, flags: d.flags });
    } catch (err) { err instanceof AiError ? bad(res, err.message, err.status) : next(err); }
  });

  // Generate more draft questions from a course's existing lessons.
  admin.post("/courses/:id/quiz/generate", needAi, aiLimit, async (req, res, next) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const lessons = db.prepare("SELECT title, body FROM lessons WHERE course_id = ? ORDER BY position").all(c.id);
    if (!lessons.length) return bad(res, "Add a lesson first");
    const count = Math.min(10, Math.max(1, Number.parseInt(req.body?.count, 10) || 5));
    try {
      const flags = [];
      const qs = tidyQuestions((await ai.generateQuiz({ lessons, count })).questions, flags);
      const start = db.prepare("SELECT COALESCE(MAX(position) + 1, 0) FROM questions WHERE course_id = ?").pluck().get(c.id);
      db.transaction(() => { insertQuestions(c.id, qs, "ai", start); touch(c.id); })();
      res.status(201).json({ added: qs.length, flags });
    } catch (err) { err instanceof AiError ? bad(res, err.message, err.status) : next(err); }
  });

  // Human review: approve, edit or delete a question. AI questions stay hidden from learners until approved.
  admin.patch("/questions/:id", (req, res) => {
    const q = db.prepare("SELECT * FROM questions WHERE id = ?").get(req.params.id);
    if (!q) return bad(res, "Question not found", 404);
    const b = req.body || {};
    const [fixed] = tidyQuestions([{ prompt: b.prompt ?? q.prompt, options: b.options ?? JSON.parse(q.options), answer: b.answer ?? q.answer, explanation: b.explanation ?? q.explanation }]);
    if (!fixed) return bad(res, "A question needs a prompt, 2 or more distinct options and a valid correct answer");
    const status = b.status === undefined ? q.status : b.status;
    if (!["draft", "approved"].includes(status)) return bad(res, "Status must be draft or approved");
    db.prepare("UPDATE questions SET prompt = ?, options = ?, answer = ?, explanation = ?, status = ? WHERE id = ?")
      .run(fixed.prompt, JSON.stringify(fixed.options), fixed.answer, fixed.explanation, status, q.id);
    touch(q.course_id);
    res.json(toQuestion(db.prepare("SELECT * FROM questions WHERE id = ?").get(q.id)));
  });

  admin.delete("/questions/:id", (req, res) => {
    const q = db.prepare("SELECT course_id FROM questions WHERE id = ?").get(req.params.id);
    if (!q) return bad(res, "Question not found", 404);
    db.prepare("DELETE FROM questions WHERE id = ?").run(req.params.id);
    touch(q.course_id);
    res.status(204).end();
  });

  admin.post("/courses/:id/publish", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    if (!db.prepare("SELECT COUNT(*) FROM lessons WHERE course_id = ?").pluck().get(c.id)) return bad(res, "Add at least one lesson first");
    db.prepare("UPDATE courses SET status = 'published', updated_at = ? WHERE id = ?").run(now(), c.id);
    res.json({ id: c.id, status: "published" });
  });

  app.use("/api/admin", admin);

  // ---- learner (published courses only; correct answers never leave the server) ----
  app.get("/api/courses", (req, res) =>
    res.json(db.prepare("SELECT id, title, description FROM courses WHERE status = 'published' ORDER BY title").all()));

  app.get("/api/courses/:id", (req, res) => {
    const c = course(req.params.id);
    if (!c || c.status !== "published") return bad(res, "Course not found", 404);
    res.json({ id: c.id, title: c.title, description: c.description,
      lessons: db.prepare("SELECT id, title, body FROM lessons WHERE course_id = ? ORDER BY position").all(c.id),
      questions: db.prepare("SELECT id, prompt, options FROM questions WHERE course_id = ? AND status = 'approved' ORDER BY position").all(c.id)
        .map(q => ({ id: q.id, prompt: q.prompt, options: JSON.parse(q.options) })) });
  });

  // Marked on the server. Body: { answers: { "<questionId>": <optionIndex> } }
  app.post("/api/courses/:id/quiz", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), (req, res) => {
    const c = course(req.params.id);
    if (!c || c.status !== "published") return bad(res, "Course not found", 404);
    const given = req.body?.answers;
    if (!given || typeof given !== "object" || Array.isArray(given)) return bad(res, "Send answers as an object of questionId to option index");
    const qs = db.prepare("SELECT id, answer, explanation FROM questions WHERE course_id = ? AND status = 'approved' ORDER BY position").all(c.id);
    const results = qs.map(q => ({ id: q.id, correct: given[q.id] === q.answer, explanation: q.explanation }));
    res.json({ score: results.filter(r => r.correct).length, total: qs.length, results });
  });

  app.use("/", express.static(new URL("../public", import.meta.url).pathname));

  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return bad(res, "That request is too large", 413);
    if (err.type === "entity.parse.failed") return bad(res, "Invalid JSON");
    console.error(err);
    bad(res, "Something went wrong", 500);
  });
  return app;
}
