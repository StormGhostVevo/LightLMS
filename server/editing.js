import { cleanBody, plain, tidyQuestions } from "./ai.js";
import { cleanupLessonImages } from "./images.js";

const now = () => new Date().toISOString();
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

export const LIMITS = { lessons: 100, questions: 200, bodyChars: 100_000 };

const toQuestion = r => ({ id: r.id, prompt: r.prompt, options: JSON.parse(r.options), answer: r.answer, explanation: r.explanation, source: r.source, status: r.status });

// Authoring: create and delete courses, add/edit/delete/reorder lessons and questions (staff only).
// Edits to a published course are live straight away; there is no draft copy of a published course.
// Anything that changes what a course requires re-checks completion so nobody is left stuck behind a rule that moved.
export function mountEditing({ admin, db, course, touch, evaluateEveryone }) {
  const recheck = courseId => evaluateEveryone(db, course(courseId));

  const lessonFields = (b, current = {}) => {
    const title = b.title === undefined ? current.title : plain(b.title).slice(0, 200);
    if (b.body !== undefined && (typeof b.body !== "string" || b.body.length > LIMITS.bodyChars)) return { error: `A lesson body must be text up to ${LIMITS.bodyChars} characters` };
    const body = b.body === undefined ? current.body : cleanBody(b.body);
    if (!title) return { error: "A lesson needs a title" };
    if (!body) return { error: "A lesson needs some content" };
    return { title, body };
  };

  // Reorders by id: the list must be exactly the current set, so nothing is dropped or invented by accident.
  const reorder = (table, courseId, order, res) => {
    const current = db.prepare(`SELECT id FROM ${table} WHERE course_id = ?`).pluck().all(courseId);
    if (!Array.isArray(order) || order.length !== current.length || new Set(order).size !== order.length || !order.every(id => current.includes(id)))
      return bad(res, "Send every id for this course exactly once as { order: [...] }");
    const set = db.prepare(`UPDATE ${table} SET position = ? WHERE id = ? AND course_id = ?`);
    db.transaction(() => { order.forEach((id, i) => set.run(i, id, courseId)); touch(courseId); })();
    res.json({ order });
  };

  // ---- courses ----
  admin.post("/courses", (req, res) => {
    const title = plain(req.body?.title).slice(0, 200);
    if (!title) return bad(res, "A course needs a title");
    const t = now();
    const { lastInsertRowid } = db.prepare("INSERT INTO courses (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(title, plain(req.body?.description).slice(0, 1000), t, t);
    res.status(201).json({ id: lastInsertRowid, title });
  });

  // Takes a course off the learner side without losing anything. Enrolments, attempts and completions are kept.
  admin.post("/courses/:id/unpublish", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    db.prepare("UPDATE courses SET status = 'draft', updated_at = ? WHERE id = ?").run(now(), c.id);
    res.json({ id: c.id, status: "draft" });
  });

  // Only drafts can be deleted, because deleting removes every attempt and completion with them.
  admin.delete("/courses/:id", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    if (c.status !== "draft") return bad(res, "Unpublish the course before deleting it", 409);
    db.prepare("DELETE FROM courses WHERE id = ?").run(c.id);
    res.status(204).end();
  });

  // ---- lessons ----
  admin.post("/courses/:id/lessons", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const f = lessonFields(req.body || {});
    if (f.error) return bad(res, f.error);
    if (db.prepare("SELECT COUNT(*) FROM lessons WHERE course_id = ?").pluck().get(c.id) >= LIMITS.lessons) return bad(res, `A course can have up to ${LIMITS.lessons} lessons`, 409);
    const pos = db.prepare("SELECT COALESCE(MAX(position) + 1, 0) FROM lessons WHERE course_id = ?").pluck().get(c.id);
    const { lastInsertRowid } = db.prepare("INSERT INTO lessons (course_id, position, title, body) VALUES (?, ?, ?, ?)").run(c.id, pos, f.title, f.body);
    touch(c.id);
    cleanupLessonImages(db, c.id);
    res.status(201).json({ id: lastInsertRowid, position: pos, ...f });
  });

  admin.put("/courses/:id/lessons/order", (req, res) => {
    if (!course(req.params.id)) return bad(res, "Course not found", 404);
    reorder("lessons", Number(req.params.id), req.body?.order, res);
  });

  admin.patch("/lessons/:id", (req, res) => {
    const l = db.prepare("SELECT * FROM lessons WHERE id = ?").get(req.params.id);
    if (!l) return bad(res, "Lesson not found", 404);
    const f = lessonFields(req.body || {}, l);
    if (f.error) return bad(res, f.error);
    db.prepare("UPDATE lessons SET title = ?, body = ? WHERE id = ?").run(f.title, f.body, l.id);
    touch(l.course_id);
    cleanupLessonImages(db, l.course_id);
    res.json({ id: l.id, position: l.position, ...f });
  });

  // Deleting a lesson removes people's ticks for it. Completions already earned stay.
  admin.delete("/lessons/:id", (req, res) => {
    const l = db.prepare("SELECT * FROM lessons WHERE id = ?").get(req.params.id);
    if (!l) return bad(res, "Lesson not found", 404);
    const c = course(l.course_id);
    if (c.status === "published" && db.prepare("SELECT COUNT(*) FROM lessons WHERE course_id = ?").pluck().get(c.id) <= 1)
      return bad(res, "A published course needs at least one lesson. Unpublish it first.", 409);
    db.transaction(() => {
      db.prepare("DELETE FROM lessons WHERE id = ?").run(l.id);
      db.prepare("UPDATE lessons SET position = position - 1 WHERE course_id = ? AND position > ?").run(c.id, l.position);   // close the gap
      touch(c.id);
    })();
    recheck(c.id);
    cleanupLessonImages(db, c.id);
    res.status(204).end();
  });

  // ---- questions ----
  // Written by a person, so approved by default unless the caller says draft.
  admin.post("/courses/:id/questions", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const b = req.body || {};
    const [q] = tidyQuestions([{ prompt: b.prompt, options: b.options, answer: b.answer, explanation: b.explanation }]);
    if (!q) return bad(res, "A question needs a prompt, 2 or more distinct options and a valid correct answer");
    const status = b.status ?? "approved";
    if (!["draft", "approved"].includes(status)) return bad(res, "Status must be draft or approved");
    if (db.prepare("SELECT COUNT(*) FROM questions WHERE course_id = ?").pluck().get(c.id) >= LIMITS.questions) return bad(res, `A course can have up to ${LIMITS.questions} questions`, 409);
    const pos = db.prepare("SELECT COALESCE(MAX(position) + 1, 0) FROM questions WHERE course_id = ?").pluck().get(c.id);
    const { lastInsertRowid } = db.prepare("INSERT INTO questions (course_id, position, prompt, options, answer, explanation, source, status) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)")
      .run(c.id, pos, q.prompt, JSON.stringify(q.options), q.answer, q.explanation, status);
    touch(c.id);
    recheck(c.id);
    res.status(201).json(toQuestion(db.prepare("SELECT * FROM questions WHERE id = ?").get(lastInsertRowid)));
  });

  admin.put("/courses/:id/questions/order", (req, res) => {
    if (!course(req.params.id)) return bad(res, "Course not found", 404);
    reorder("questions", Number(req.params.id), req.body?.order, res);
  });
}
