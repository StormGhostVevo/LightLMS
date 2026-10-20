import { cleanOptions } from "./shared.js";

/** @typedef {import("./shared.js").QuestionType} QuestionType */

/** Marks a pick from a list of options. Shared with true or false. */
export const markChoice = (row, spec, given) => {
  const options = JSON.parse(row.options);
  const chosen = Number.isInteger(given) && given >= 0 && given < options.length ? given : null;
  return { chosen, correct: chosen === row.answer, key: { answer: row.answer } };
};

// Attempts taken before there were question types have no `type` and no `key`; they are multiple choice with `answer`.
export const choiceYourAnswer = d =>
  d.chosen === null || d.chosen === undefined ? "No answer" : d.options[d.chosen];
export const choiceCorrectAnswer = d => d.options[d.key?.answer ?? d.answer];

/** @type {QuestionType} */
export const mcq = {
  key: "mcq",
  label: "Multiple choice",
  clean(q) {
    const o = cleanOptions(q.options);
    if ("error" in o) return o;
    if (!Number.isInteger(q.answer) || !o.map.has(q.answer))
      return { error: "Select which option is correct." };
    return { options: o.options, answer: o.map.get(q.answer) };
  },
  forAdmin: row => ({ options: JSON.parse(row.options), answer: row.answer }),
  forLearner: row => ({ options: JSON.parse(row.options) }),
  mark: markChoice,
  yourAnswer: choiceYourAnswer,
  correctAnswer: choiceCorrectAnswer,
};
