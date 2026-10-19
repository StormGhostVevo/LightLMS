import { rateLimit } from "express-rate-limit";

const now = () => new Date().toISOString();
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

// Spreadsheet apps run cells that start with these as formulas, so defang them in exports.
const csvCell = v => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Quiz attempts (learner) and the gradebook (staff). Marking happens only here, on the server.
export function mountQuiz({ app, admin, db, course, visible, enrolled, requireLogin, evaluate }) {
  const passedBefore = (courseId, userId) =>
    !!db.prepare("SELECT 1 FROM attempts WHERE course_id = ? AND user_id = ? AND passed = 1").get(courseId, userId);
  const used = (courseId, userId) =>
    db.prepare("SELECT COUNT(*) FROM attempts WHERE course_id = ? AND user_id = ?").pluck().get(courseId, userId);
  const reveals = (c, userId) => c.show_answers === "always" || (c.show_answers === "after_pass" && passedBefore(c.id, userId));

  // What a learner sees of an attempt. Correct options and explanations only appear when the course allows it.
  const shape = (a, c, reveal) => ({
    id: a.id, courseId: a.course_id, score: a.score, total: a.total, percent: a.percent, passed: !!a.passed, passMark: a.pass_mark, submittedAt: a.submitted_at,
    results: JSON.parse(a.detail).map(d => ({
      id: d.id, prompt: d.prompt, options: d.options, chosen: d.chosen, correct: d.correct,
      ...(reveal ? { answer: d.answer, explanation: d.explanation } : {}),
    })),
  });

  // Body: { answers: { "<questionId>": <optionIndex> } }
  app.post("/api/courses/:id/quiz", requireLogin, rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), (req, res) => {
    const c = visible(req, res);
    if (!c) return;
    if (!enrolled(c.id, req.user.id)) return bad(res, "Enrol in this course to take the quiz", 403);
    const given = req.body?.answers;
    if (!given || typeof given !== "object" || Array.isArray(given)) return bad(res, "Send answers as an object of questionId to option index");
    const qs = db.prepare("SELECT * FROM questions WHERE course_id = ? AND status = 'approved' ORDER BY position").all(c.id);
    if (!qs.length) return bad(res, "This course doesn't have a quiz yet", 409);

    const detail = qs.map(q => {
      const options = JSON.parse(q.options);
      const chosen = Number.isInteger(given[q.id]) && given[q.id] >= 0 && given[q.id] < options.length ? given[q.id] : null; // unanswered counts as wrong
      return { id: q.id, prompt: q.prompt, options, chosen, answer: q.answer, correct: chosen === q.answer, explanation: q.explanation };
    });
    const score = detail.filter(d => d.correct).length;
    const percent = Math.round((score / detail.length) * 100);

    // The attempt limit is checked and the row written in one transaction, so two quick submissions can't both slip under it.
    let attempt;
    try {
      attempt = db.transaction(() => {
        if (c.max_attempts != null && used(c.id, req.user.id) >= c.max_attempts) throw Object.assign(new Error("limit"), { limit: true });
        const { lastInsertRowid } = db.prepare(`INSERT INTO attempts (course_id, user_id, score, total, percent, passed, pass_mark, detail, submitted_at)
                                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(c.id, req.user.id, score, detail.length, percent, percent >= c.pass_mark ? 1 : 0, c.pass_mark, JSON.stringify(detail), now());
        return db.prepare("SELECT * FROM attempts WHERE id = ?").get(lastInsertRowid);
      })();
    } catch (err) {
      if (err.limit) return bad(res, `You've used all ${c.max_attempts} attempts for this quiz`, 409);
      throw err;
    }
    evaluate(db, c, req.user.id);   // a pass may complete the course
    res.status(201).json({ ...shape(attempt, c, reveals(c, req.user.id)), attemptsUsed: used(c.id, req.user.id), maxAttempts: c.max_attempts });
  });

  // My attempts on a course, newest first (summary only).
  app.get("/api/courses/:id/attempts", requireLogin, (req, res) => {
    const c = visible(req, res);
    if (!c) return;
    const rows = db.prepare("SELECT id, score, total, percent, passed, submitted_at FROM attempts WHERE course_id = ? AND user_id = ? ORDER BY id DESC").all(c.id, req.user.id)
      .map(a => ({ id: a.id, score: a.score, total: a.total, percent: a.percent, passed: !!a.passed, submittedAt: a.submitted_at }));
    res.json({ passMark: c.pass_mark, maxAttempts: c.max_attempts, attemptsUsed: rows.length, passed: rows.some(a => a.passed), attempts: rows });
  });

  // One of my own attempts, in full. Reading someone else's attempt looks like it doesn't exist.
  app.get("/api/attempts/:id", requireLogin, (req, res) => {
    const a = db.prepare("SELECT * FROM attempts WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
    if (!a) return bad(res, "Attempt not found", 404);
    const c = course(a.course_id);
    res.json(shape(a, c, reveals(c, req.user.id)));
  });

  // My grades across all my courses.
  app.get("/api/grades", requireLogin, (req, res) =>
    res.json(db.prepare(`SELECT c.id AS courseId, c.title, c.pass_mark AS passMark, COUNT(a.id) AS attempts, MAX(a.percent) AS bestPercent,
                                COALESCE(MAX(a.passed), 0) AS passed, MAX(a.submitted_at) AS lastAttemptAt
                         FROM enrolments e JOIN courses c ON c.id = e.course_id AND c.status = 'published'
                         LEFT JOIN attempts a ON a.course_id = c.id AND a.user_id = e.user_id
                         WHERE e.user_id = ? GROUP BY c.id ORDER BY c.title`).all(req.user.id).map(r => ({ ...r, passed: !!r.passed }))));

  // ---- gradebook (authors and admins) ----
  const gradebook = courseId => db.prepare(`
    SELECT u.id AS userId, u.email, u.name, COUNT(a.id) AS attempts, MAX(a.percent) AS bestPercent,
           COALESCE(MAX(a.passed), 0) AS passed, MAX(a.submitted_at) AS lastAttemptAt,
           (SELECT COUNT(*) FROM lesson_progress lp WHERE lp.course_id = e.course_id AND lp.user_id = e.user_id) AS lessonsCompleted,
           cc.completed_at AS completedAt
    FROM enrolments e JOIN users u ON u.id = e.user_id
    LEFT JOIN attempts a ON a.course_id = e.course_id AND a.user_id = e.user_id
    LEFT JOIN course_completions cc ON cc.course_id = e.course_id AND cc.user_id = e.user_id
    WHERE e.course_id = ? GROUP BY u.id ORDER BY u.email`).all(courseId).map(r => ({ ...r, passed: !!r.passed }));

  admin.get("/courses/:id/gradebook", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const learners = gradebook(c.id);
    const tried = learners.filter(l => l.attempts > 0);

    // Share of attempts that got each question right: the questions most people miss are the ones to improve.
    const stats = new Map();
    for (const { detail } of db.prepare("SELECT detail FROM attempts WHERE course_id = ?").all(c.id))
      for (const d of JSON.parse(detail)) {
        const s = stats.get(d.id) || { id: d.id, prompt: d.prompt, attempts: 0, correct: 0 };
        s.attempts++; if (d.correct) s.correct++; s.prompt = d.prompt;
        stats.set(d.id, s);
      }
    res.json({
      course: { id: c.id, title: c.title, passMark: c.pass_mark, maxAttempts: c.max_attempts },
      summary: {
        enrolled: learners.length, attempted: tried.length, passed: learners.filter(l => l.passed).length, completed: learners.filter(l => l.completedAt).length,
        lessons: db.prepare("SELECT COUNT(*) FROM lessons WHERE course_id = ?").pluck().get(c.id),
        averageBestPercent: tried.length ? Math.round(tried.reduce((n, l) => n + l.bestPercent, 0) / tried.length) : null,
      },
      learners,
      questions: [...stats.values()].map(s => ({ id: s.id, prompt: s.prompt, attempts: s.attempts, percentCorrect: Math.round((s.correct / s.attempts) * 100) }))
        .sort((a, b) => a.percentCorrect - b.percentCorrect),
    });
  });

  admin.get("/courses/:id/gradebook.csv", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const rows = [["Email", "Name", "Lessons done", "Attempts", "Best %", "Passed", "Completed", "Last attempt"],
      ...gradebook(c.id).map(l => [l.email, l.name, l.lessonsCompleted, l.attempts, l.bestPercent ?? "", l.passed ? "Yes" : "No", l.completedAt ?? "", l.lastAttemptAt ?? ""])];
    res.type("text/csv").set("Content-Disposition", `attachment; filename="gradebook-${c.id}.csv"`).send(rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n");
  });

  // One learner's attempts on a course, answers included: staff need to see what was chosen.
  admin.get("/courses/:id/users/:userId/attempts", (req, res) => {
    if (!course(req.params.id)) return bad(res, "Course not found", 404);
    res.json(db.prepare("SELECT * FROM attempts WHERE course_id = ? AND user_id = ? ORDER BY id DESC").all(req.params.id, req.params.userId)
      .map(a => ({ ...shape(a, { show_answers: "always" }, true) })));
  });
}
