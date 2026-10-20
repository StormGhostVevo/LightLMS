import { HttpError, now } from "../http.js";

/**
 * Who is enrolled in which course, and who may read it.
 * @param {import("better-sqlite3").Database} db
 */
export function createEnrolment(db) {
  const isEnrolled = (courseId, userId) =>
    !!db.prepare("SELECT 1 FROM enrolments WHERE course_id = ? AND user_id = ?").get(courseId, userId);

  const list = courseId =>
    /** @type {any[]} */ (
      db
        .prepare(
          `SELECT u.id, u.email, u.name, u.role, e.enrolled_at, e.enrolled_by IS NULL AS self_enrolled
           FROM enrolments e JOIN users u ON u.id = e.user_id WHERE e.course_id = ? ORDER BY u.email`,
        )
        .all(courseId)
    ).map(r => ({ ...r, self_enrolled: !!r.self_enrolled }));

  /**
   * Enrols people by email. Unknown or inactive emails are reported back, never silently skipped.
   * @returns {{ enrolled: string[], alreadyEnrolled: string[], notFound: string[] }}
   */
  const enrolEmails = (course, emails, byUserId) => {
    if (
      !Array.isArray(emails) ||
      !emails.length ||
      emails.length > 500 ||
      emails.some(e => typeof e !== "string")
    )
      throw new HttpError(400, "Send up to 500 email addresses as { emails: [...] }");
    const out = { enrolled: [], alreadyEnrolled: [], notFound: [] };
    const find = db.prepare("SELECT id FROM users WHERE email = ? AND active = 1");
    const insert = db.prepare(
      "INSERT OR IGNORE INTO enrolments (course_id, user_id, enrolled_at, enrolled_by) VALUES (?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (const email of new Set(emails.map(e => e.trim().toLowerCase()))) {
        const user = /** @type {any} */ (find.get(email));
        if (!user) out.notFound.push(email);
        else
          (insert.run(course.id, user.id, now(), byUserId).changes ? out.enrolled : out.alreadyEnrolled).push(
            email,
          );
      }
    })();
    return out;
  };

  /** Removes someone. Their results are kept. Returns their email. */
  const unenrol = (courseId, userId) => {
    const email = db.prepare("SELECT email FROM users WHERE id = ?").pluck().get(userId);
    const r = db.prepare("DELETE FROM enrolments WHERE course_id = ? AND user_id = ?").run(courseId, userId);
    if (!r.changes) throw new HttpError(404, "That person isn't enrolled");
    return email;
  };

  /** A learner joins a course that is open to everyone. */
  const selfEnrol = (course, userId) => {
    if (!course || course.status !== "published" || course.enrolment !== "open")
      throw new HttpError(404, "That course isn't open for self-enrolment");
    db.prepare(
      "INSERT OR IGNORE INTO enrolments (course_id, user_id, enrolled_at, enrolled_by) VALUES (?, ?, ?, NULL)",
    ).run(course.id, userId, now());
  };

  return { isEnrolled, list, enrolEmails, unenrol, selfEnrol };
}
