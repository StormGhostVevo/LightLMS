import { HttpError, now } from "../http.js";
import { plain } from "../text.js";
import { MIN_SOURCE, MAX_SOURCE, tidyDraft } from "../ai.js";
import { TYPES, tidyQuestions, insertQuestion } from "../question-types/index.js";

/**
 * The two things the AI does for authors. Everything it writes is untrusted: it is cleaned and validated first,
 * and every question it writes starts as a draft for a person to approve.
 * @param {import("better-sqlite3").Database} db
 * @param {any} ai the provider: the real one, the offline stand-in, or "off"
 * @param {{ touch: (id: any) => void }} courses
 */
export function createAiAuthoring(db, ai, courses) {
  const insertQuestions = (courseId, qs, start = 0) =>
    qs.forEach((q, i) => insertQuestion(db, courseId, start + i, q, "ai"));

  /** Drafts a whole course (lessons and draft questions) from pasted source material. */
  const draftCourse = async text => {
    const source = typeof text === "string" ? text.trim() : "";
    if (source.length < MIN_SOURCE)
      throw new HttpError(400, "Add a bit more text first (at least a couple of sentences)");
    if (source.length > MAX_SOURCE) throw new HttpError(400, "That's too long for one draft. Split it up.");
    const d = tidyDraft(await ai.draftCourse({ text: source }));
    if (!d.lessons.length)
      throw new HttpError(422, "The AI didn't produce any lessons. Try different material.");
    const id = db.transaction(() => {
      const t = now();
      const { lastInsertRowid } = db
        .prepare("INSERT INTO courses (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(d.title, d.description, t, t);
      const ins = db.prepare("INSERT INTO lessons (course_id, position, title, body) VALUES (?, ?, ?, ?)");
      d.lessons.forEach((l, i) => ins.run(lastInsertRowid, i, l.title, l.body));
      insertQuestions(lastInsertRowid, d.questions);
      return lastInsertRowid;
    })();
    return { id, title: d.title, lessons: d.lessons.length, questions: d.questions.length, flags: d.flags };
  };

  /** Writes more draft questions from a course's lessons. `types` defaults to multiple choice. */
  const generateQuiz = async (course, countInput, typesInput) => {
    const lessons = db
      .prepare("SELECT title, body FROM lessons WHERE course_id = ? ORDER BY position")
      .all(course.id);
    if (!lessons.length) throw new HttpError(400, "Add a lesson first");
    const count = Math.min(10, Math.max(1, Number.parseInt(countInput, 10) || 5));
    const types = typesInput === undefined ? ["mcq"] : typesInput;
    if (!Array.isArray(types) || !types.length || types.some(t => !TYPES[t]))
      throw new HttpError(400, "Choose which question types to include");
    const unique = [...new Set(types)];

    const made = await ai.generateQuiz({ lessons, count, types: unique });
    const flags = (made.flags || []).map(plain).filter(Boolean).slice(0, 10); // the AI's own "please check this" notes
    const qs = tidyQuestions(made.questions, flags);
    const start = db
      .prepare("SELECT COALESCE(MAX(position) + 1, 0) FROM questions WHERE course_id = ?")
      .pluck()
      .get(course.id);
    db.transaction(() => {
      insertQuestions(course.id, qs, /** @type {number} */ (start));
      courses.touch(course.id);
    })();
    return { added: qs.length, types: unique, flags };
  };

  return { draftCourse, generateQuiz };
}
