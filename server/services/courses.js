import { HttpError, now } from "../http.js";
import { plain } from "../text.js";
import { imageOf } from "../images.js";
import { toAdmin, forLearner } from "../questions.js";
import { evaluateEveryone, progress } from "../completion.js";

const ENROLMENT = ["manual", "open"];
const COMPLETION = ["lessons", "quiz", "both"];
const SHOW_ANSWERS = ["never", "after_pass", "always"];

/**
 * Everything about a course itself: finding it, listing it for each audience, its settings and its status.
 * Methods throw HttpError with a message meant for people, so route handlers stay short.
 * @param {import("better-sqlite3").Database} db
 */
export function createCourses(db) {
  /** @returns {any} the course row, or undefined */
  const get = id => db.prepare("SELECT * FROM courses WHERE id = ?").get(id);
  /** Like `get`, but a missing course is a 404. */
  const need = id => {
    const c = get(id);
    if (!c) throw new HttpError(404, "Course not found");
    return c;
  };
  const touch = id => db.prepare("UPDATE courses SET updated_at = ? WHERE id = ?").run(now(), id);

  /** For staff: every course, newest change first. */
  const adminList = () =>
    /** @type {any[]} */ (
      db
        .prepare(
          "SELECT id, title, description, status, updated_at, image_key, image_alt FROM courses ORDER BY updated_at DESC",
        )
        .all()
    ).map(({ image_key, image_alt, ...c }) => ({ ...c, image: imageOf({ image_key, image_alt }) }));

  /** For staff: the whole course with its lessons and questions, answer keys included. */
  const adminDetail = c => {
    const { image_key: _key, image_alt: _alt, ...rest } = c;
    return {
      ...rest,
      image: imageOf(c),
      lessons: db
        .prepare("SELECT id, position, title, body FROM lessons WHERE course_id = ? ORDER BY position")
        .all(c.id),
      questions: /** @type {any[]} */ (
        db.prepare("SELECT * FROM questions WHERE course_id = ? ORDER BY position").all(c.id)
      ).map(toAdmin),
    };
  };

  /** For a learner: the published courses they are enrolled in, with their progress. */
  const learnerList = userId =>
    /** @type {any[]} */ (
      db
        .prepare(
          `SELECT c.* FROM courses c JOIN enrolments e ON e.course_id = c.id
           WHERE c.status = 'published' AND e.user_id = ? ORDER BY c.title`,
        )
        .all(userId)
    ).map(c => {
      const p = progress(db, c, userId);
      return {
        id: c.id,
        title: c.title,
        description: c.description,
        image: imageOf(c),
        percent: p.percent,
        completed: p.completed,
      };
    });

  /** Open courses a learner could join. */
  const available = userId =>
    /** @type {any[]} */ (
      db
        .prepare(
          `SELECT id, title, description, image_key, image_alt FROM courses
           WHERE status = 'published' AND enrolment = 'open'
           AND id NOT IN (SELECT course_id FROM enrolments WHERE user_id = ?) ORDER BY title`,
        )
        .all(userId)
    ).map(({ image_key, image_alt, ...c }) => ({ ...c, image: imageOf({ image_key, image_alt }) }));

  /** What a learner may read of a course: no answer keys, and only approved questions. */
  const learnerView = c => ({
    id: c.id,
    title: c.title,
    description: c.description,
    image: imageOf(c),
    passMark: c.pass_mark,
    maxAttempts: c.max_attempts,
    lessons: db
      .prepare("SELECT id, title, body FROM lessons WHERE course_id = ? ORDER BY position")
      .all(c.id),
    questions: /** @type {any[]} */ (
      db
        .prepare("SELECT * FROM questions WHERE course_id = ? AND status = 'approved' ORDER BY position")
        .all(c.id)
    ).map(forLearner),
  });

  /**
   * Changes whichever settings are sent; the rest stay as they were.
   * @returns {{ settings: object, changed: Record<string, { from: unknown, to: unknown }> }}
   */
  const updateSettings = (c, b) => {
    const title = b.title === undefined ? c.title : plain(b.title).slice(0, 200);
    const description = b.description === undefined ? c.description : plain(b.description).slice(0, 1000);
    const enrolment = b.enrolment ?? c.enrolment;
    if (!title) throw new HttpError(400, "A course needs a title");
    if (!ENROLMENT.includes(enrolment)) throw new HttpError(400, "Enrolment must be manual or open");
    const passMark = b.passMark ?? c.pass_mark;
    if (!Number.isInteger(passMark) || passMark < 0 || passMark > 100)
      throw new HttpError(400, "Pass mark must be a whole number from 0 to 100");
    const maxAttempts = b.maxAttempts === undefined ? c.max_attempts : b.maxAttempts; // null means unlimited
    if (maxAttempts !== null && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50))
      throw new HttpError(400, "Max attempts must be 1 to 50, or null for unlimited");
    if (b.certificate !== undefined && typeof b.certificate !== "boolean")
      throw new HttpError(400, "certificate must be true or false");
    const certificate = b.certificate === undefined ? c.certificate_enabled : Number(b.certificate);
    const completion = b.completion ?? c.completion_rule;
    if (!COMPLETION.includes(completion))
      throw new HttpError(400, "completion must be lessons, quiz or both");
    const showAnswers = b.showAnswers ?? c.show_answers;
    if (!SHOW_ANSWERS.includes(showAnswers))
      throw new HttpError(400, "showAnswers must be never, after_pass or always");

    db.prepare(
      `UPDATE courses SET title = ?, description = ?, enrolment = ?, pass_mark = ?, max_attempts = ?,
       show_answers = ?, completion_rule = ?, certificate_enabled = ?, updated_at = ? WHERE id = ?`,
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
    if (completion !== c.completion_rule) evaluateEveryone(db, get(c.id));

    const after = {
      title,
      enrolment,
      pass_mark: passMark,
      max_attempts: maxAttempts,
      show_answers: showAnswers,
      completion_rule: completion,
      certificate_enabled: certificate,
    };
    const changed = Object.fromEntries(
      Object.entries(after)
        .filter(([k, v]) => c[k] !== v)
        .map(([k, v]) => [k, { from: c[k], to: v }]),
    );
    return {
      settings: {
        id: c.id,
        title,
        description,
        enrolment,
        passMark,
        maxAttempts,
        showAnswers,
        completion,
        certificate: !!certificate,
      },
      changed,
    };
  };

  /** A course needs a lesson before learners can see it. */
  const publish = c => {
    if (!db.prepare("SELECT COUNT(*) FROM lessons WHERE course_id = ?").pluck().get(c.id))
      throw new HttpError(400, "Add at least one lesson first");
    db.prepare("UPDATE courses SET status = 'published', updated_at = ? WHERE id = ?").run(now(), c.id);
  };

  return {
    get,
    need,
    touch,
    adminList,
    adminDetail,
    learnerList,
    available,
    learnerView,
    updateSettings,
    publish,
  };
}
