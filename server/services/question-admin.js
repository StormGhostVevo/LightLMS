import { HttpError } from "../http.js";
import { cleanQuestion, toAdmin } from "../questions.js";
import { evaluateEveryone } from "../completion.js";

// The fields of a question that an edit may replace.
const FIELDS = [
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

/**
 * Editing and deleting questions: the human review step. AI questions stay hidden from learners until approved.
 * @param {import("better-sqlite3").Database} db
 * @param {{ get: (id: any) => any, touch: (id: any) => void }} courses
 */
export function createQuestionAdmin(db, courses) {
  const find = id => db.prepare("SELECT * FROM questions WHERE id = ?").get(id);

  /** Fields that are sent replace the question's; the rest stay. Changing the type needs everything the new type requires. */
  const update = (id, body) => {
    const q = /** @type {any} */ (find(id));
    if (!q) throw new HttpError(404, "Question not found");
    const status = body.status === undefined ? q.status : body.status;
    if (!["draft", "approved"].includes(status)) throw new HttpError(400, "Status must be draft or approved");
    const fixed = cleanQuestion({
      ...toAdmin(q),
      ...Object.fromEntries(FIELDS.filter(f => body[f] !== undefined).map(f => [f, body[f]])),
    });
    if (fixed.error) throw new HttpError(400, fixed.error);
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
    courses.touch(q.course_id);
    evaluateEveryone(db, courses.get(q.course_id)); // approving or unapproving changes whether the course has a quiz
    return toAdmin(find(q.id));
  };

  const remove = id => {
    const q = /** @type {any} */ (find(id));
    if (!q) throw new HttpError(404, "Question not found");
    db.prepare("DELETE FROM questions WHERE id = ?").run(q.id);
    courses.touch(q.course_id);
    evaluateEveryone(db, courses.get(q.course_id));
  };

  return { update, remove };
}
