import { cleanOptions } from "./shared.js";

/** @typedef {import("./shared.js").QuestionType} QuestionType */

/** Select all that apply. Right only if exactly the right set is chosen. */
/** @type {QuestionType} */
export const multipleResponse = {
  key: "multiple_response",
  label: "Multiple response (select all that apply)",
  clean(q) {
    const o = cleanOptions(q.options);
    if ("error" in o) return o;
    const picked = [
      ...new Set(
        (Array.isArray(q.answers) ? q.answers : [])
          .filter(i => Number.isInteger(i) && o.map.has(i))
          .map(i => o.map.get(i)),
      ),
    ].sort((a, b) => a - b);
    if (!picked.length) return { error: "Select at least one correct option." };
    return { options: o.options, spec: { answers: picked } };
  },
  forAdmin: (row, spec) => ({ options: JSON.parse(row.options), answers: spec.answers }),
  forLearner: row => ({ options: JSON.parse(row.options) }),
  mark(row, spec, given) {
    const options = JSON.parse(row.options);
    const picked = Array.isArray(given)
      ? [...new Set(given.filter(i => Number.isInteger(i) && i >= 0 && i < options.length))].sort(
          (a, b) => a - b,
        )
      : [];
    const chosen = picked.length ? picked : null;
    const correct =
      !!chosen && chosen.length === spec.answers.length && chosen.every((v, i) => v === spec.answers[i]);
    return { chosen, correct, key: { answers: spec.answers } };
  },
  yourAnswer: d => (d.chosen ? d.chosen.map(i => d.options[i]).join("; ") : "No answer"),
  correctAnswer: d => d.key.answers.map(i => d.options[i]).join("; "),
};
