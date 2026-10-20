import { issueCertificate } from "./certificates.js";

const now = () => new Date().toISOString();
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

// Where one person stands on one course, against the course's completion rule.
export function progress(db, c, userId) {
  const lessons = db
    .prepare(
      `SELECT l.id, l.title, lp.completed_at IS NOT NULL AS done FROM lessons l
                              LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = ?
                              WHERE l.course_id = ? ORDER BY l.position`,
    )
    .all(userId, c.id)
    .map(l => ({ id: l.id, title: l.title, completed: !!l.done }));
  const hasQuiz =
    db.prepare("SELECT 1 FROM questions WHERE course_id = ? AND status = 'approved' LIMIT 1").get(c.id) !=
    null;
  const quizPassed =
    db
      .prepare("SELECT 1 FROM attempts WHERE course_id = ? AND user_id = ? AND passed = 1 LIMIT 1")
      .get(c.id, userId) != null;

  const needLessons = c.completion_rule !== "quiz";
  const needQuiz = c.completion_rule !== "lessons" && hasQuiz;
  const parts = []; // each requirement as done / not done
  if (needLessons) parts.push(...lessons.map(l => l.completed));
  if (needQuiz) parts.push(quizPassed);

  const record = db
    .prepare("SELECT completed_at FROM course_completions WHERE course_id = ? AND user_id = ?")
    .get(c.id, userId);
  return {
    rule: c.completion_rule,
    lessons,
    quiz: { required: needQuiz, passed: quizPassed },
    percent: record
      ? 100
      : parts.length
        ? Math.round((parts.filter(Boolean).length / parts.length) * 100)
        : 0,
    // A course with nothing to require can never complete, rather than completing instantly.
    meetsRule: parts.length > 0 && parts.every(Boolean),
    completed: !!record,
    completedAt: record?.completed_at ?? null,
  };
}

// Records completion the first time the rule is met. Safe to call any time; returns the completion time or null.
export function evaluate(db, c, userId) {
  const p = progress(db, c, userId);
  if (p.completed) return p.completedAt;
  if (!p.meetsRule) return null;
  const at = now();
  db.prepare(
    "INSERT OR IGNORE INTO course_completions (user_id, course_id, completed_at) VALUES (?, ?, ?)",
  ).run(userId, c.id, at);
  issueCertificate(db, c, userId);
  return at;
}

export const evaluateEveryone = (db, c) =>
  db
    .prepare("SELECT user_id FROM enrolments WHERE course_id = ?")
    .pluck()
    .all(c.id)
    .forEach(uid => evaluate(db, c, uid));

export function mountCompletion({ app, db, visible, enrolled, requireLogin }) {
  const view = (c, userId) => {
    evaluate(db, c, userId);
    return progress(db, c, userId);
  };

  // My progress on a course.
  app.get("/api/courses/:id/progress", requireLogin, (req, res) => {
    const c = visible(req, res);
    if (!c) return;
    res.json(view(c, req.user.id));
  });

  // Mark a lesson done (idempotent), or undo it. Only enrolled people have progress; staff previewing don't.
  const lessonAction = done => (req, res) => {
    const c = visible(req, res);
    if (!c) return;
    if (!enrolled(c.id, req.user.id)) return bad(res, "Enrol in this course to track your progress", 403);
    const lesson = db
      .prepare("SELECT id FROM lessons WHERE id = ? AND course_id = ?")
      .get(req.params.lessonId, c.id);
    if (!lesson) return bad(res, "Lesson not found", 404);
    if (done)
      db.prepare(
        "INSERT OR IGNORE INTO lesson_progress (user_id, lesson_id, course_id, completed_at) VALUES (?, ?, ?, ?)",
      ).run(req.user.id, lesson.id, c.id, now());
    else
      db.prepare("DELETE FROM lesson_progress WHERE user_id = ? AND lesson_id = ?").run(
        req.user.id,
        lesson.id,
      );
    res.json(view(c, req.user.id));
  };
  app.post("/api/courses/:id/lessons/:lessonId/complete", requireLogin, lessonAction(true));
  app.delete("/api/courses/:id/lessons/:lessonId/complete", requireLogin, lessonAction(false));
}
