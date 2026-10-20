import { randomBytes } from "node:crypto";
import { HttpError, now } from "../http.js";

const erasedEmail = id => `erased-${id}@erased.invalid`;

/**
 * Everything the site holds about one person: their right to see their own information.
 * Password hashes and session ids are left out on purpose; they are not "about" the person, they are security material.
 * @param {import("better-sqlite3").Database} db
 */
export function createPrivacy(db) {
  const user = key => {
    const u = /** @type {any} */ (
      typeof key === "number"
        ? db.prepare("SELECT * FROM users WHERE id = ?").get(key)
        : db.prepare("SELECT * FROM users WHERE email = ?").get(String(key).trim())
    );
    if (!u) throw new HttpError(404, "User not found");
    return u;
  };
  /** @returns {any[]} */
  const all = (sql, ...args) => /** @type {any[]} */ (db.prepare(sql).all(...args));

  /** @param {number | string} key a user id or an email */
  const exportPerson = key => {
    const u = user(key);
    return {
      exportedAt: now(),
      profile: {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        active: !!u.active,
        createdAt: u.created_at,
        lastSignInAt: u.last_login_at,
      },
      enrolments: all(
        `SELECT c.title AS course, e.enrolled_at AS enrolledAt, e.enrolled_by IS NULL AS joinedThemselves
         FROM enrolments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = ? ORDER BY e.enrolled_at`,
        u.id,
      ).map(r => ({ ...r, joinedThemselves: !!r.joinedThemselves })),
      lessonsMarkedDone: all(
        `SELECT c.title AS course, l.title AS lesson, p.completed_at AS at FROM lesson_progress p
         JOIN lessons l ON l.id = p.lesson_id JOIN courses c ON c.id = p.course_id WHERE p.user_id = ? ORDER BY p.completed_at`,
        u.id,
      ),
      courseCompletions: all(
        `SELECT c.title AS course, cc.completed_at AS at FROM course_completions cc JOIN courses c ON c.id = cc.course_id WHERE cc.user_id = ?`,
        u.id,
      ),
      quizAttempts: all("SELECT * FROM attempts WHERE user_id = ? ORDER BY id", u.id).map(a => ({
        course: db.prepare("SELECT title FROM courses WHERE id = ?").pluck().get(a.course_id),
        at: a.submitted_at,
        score: a.score,
        total: a.total,
        percent: a.percent,
        passed: !!a.passed,
        // What they were asked, what they answered, and whether it was right.
        answers: JSON.parse(a.detail).map(d => ({
          question: d.prompt,
          answered: d.chosen,
          correct: d.correct,
        })),
      })),
      certificates: all(
        "SELECT code, course_title AS course, recipient_name AS nameOnCertificate, issued_at AS issuedAt, revoked_at AS revokedAt FROM certificates WHERE user_id = ?",
        u.id,
      ),
      actionsTheyTook: all(
        "SELECT at, action, target_label AS about FROM audit_log WHERE actor_id = ? ORDER BY id",
        u.id,
      ),
    };
  };

  /**
   * Removes a person's information while keeping the site consistent.
   * Their account stays as an empty, disabled shell so history that points at it still makes sense.
   * - Deleted: sessions, enrolments, lesson ticks, completions and every quiz attempt (the answers are the personal part).
   * - Kept, with the name removed: certificates they were issued, which stay verifiable. "Name removed" replaces the name.
   * - Scrubbed: their email and name wherever the audit log mentions them.
   * Backups taken earlier still hold the old data until they are rotated out; see the deployment guide.
   * @returns {{ id: number, removed: Record<string, number> }}
   */
  const erasePerson = (key, { allowSelf = false, actorId = null } = {}) => {
    const u = user(key);
    if (u.email === erasedEmail(u.id)) throw new HttpError(409, "That person has already been erased.");
    if (!allowSelf && u.id === actorId) throw new HttpError(409, "You can't erase your own account.");
    if (
      u.role === "admin" &&
      u.active &&
      Number(db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1").pluck().get()) <= 1
    )
      throw new HttpError(409, "That is the last active admin. Make someone else an admin first.");

    const email = u.email;
    const name = u.name;
    /** @type {Record<string, number>} */
    const removed = {};
    db.transaction(() => {
      const del = (label, sql) => (removed[label] = db.prepare(sql).run(u.id).changes);
      del("sessions", "DELETE FROM sessions WHERE user_id = ?");
      del("enrolments", "DELETE FROM enrolments WHERE user_id = ?");
      del("lessonsMarkedDone", "DELETE FROM lesson_progress WHERE user_id = ?");
      del("courseCompletions", "DELETE FROM course_completions WHERE user_id = ?");
      del("quizAttempts", "DELETE FROM attempts WHERE user_id = ?");

      // Certificates stay valid for whoever holds the code, without the person's name.
      const certs = /** @type {any[]} */ (
        db.prepare("SELECT id, code FROM certificates WHERE user_id = ?").all(u.id)
      );
      removed.certificates = db
        .prepare("UPDATE certificates SET recipient_name = 'Name removed' WHERE user_id = ?")
        .run(u.id).changes;

      // The audit log keeps what happened, minus who it was about.
      const scrub = db.prepare("UPDATE audit_log SET actor_email = ? WHERE actor_id = ?");
      scrub.run(erasedEmail(u.id), u.id);
      db.prepare("UPDATE audit_log SET target_label = ? WHERE target_type = 'user' AND target_id = ?").run(
        erasedEmail(u.id),
        String(u.id),
      );
      for (const c of certs)
        db.prepare(
          "UPDATE audit_log SET target_label = ?, detail = '{}' WHERE target_type = 'certificate' AND target_id = ?",
        ).run(c.code, String(c.id));
      // Anywhere else their email was written into a detail or a label (for example "removed someone from a course").
      db.prepare(
        "UPDATE audit_log SET detail = REPLACE(detail, ?, ?), target_label = REPLACE(target_label, ?, ?) WHERE detail LIKE ? OR target_label LIKE ?",
      ).run(email, erasedEmail(u.id), email, erasedEmail(u.id), `%${email}%`, `%${email}%`);
      if (name && name.length >= 3) {
        db.prepare(
          "UPDATE audit_log SET detail = REPLACE(detail, ?, 'Name removed'), target_label = REPLACE(target_label, ?, 'Name removed') WHERE detail LIKE ? OR target_label LIKE ?",
        ).run(name, name, `%${name}%`, `%${name}%`);
      }

      // The account itself: emptied and disabled. The password becomes something nobody knows.
      db.prepare(
        "UPDATE users SET email = ?, name = '', role = 'learner', active = 0, must_change_password = 0, last_login_at = NULL, password_hash = ? WHERE id = ?",
      ).run(
        erasedEmail(u.id),
        `scrypt$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`,
        u.id,
      );
    })();
    return { id: u.id, removed };
  };

  return { exportPerson, erasePerson, erasedEmail };
}
