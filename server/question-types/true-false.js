import { markChoice, choiceYourAnswer, choiceCorrectAnswer } from "./mcq.js";

/** @typedef {import("./shared.js").QuestionType} QuestionType */

/** A statement that is either true or false. Stored as a choice between "True" (0) and "False" (1). */
/** @type {QuestionType} */
export const trueFalse = {
  key: "true_false",
  label: "True or false",
  clean(q) {
    const a = q.answer === true ? 0 : q.answer === false ? 1 : q.answer; // 0 is True, 1 is False
    if (a !== 0 && a !== 1) return { error: "Say whether the statement is true or false." };
    return { options: ["True", "False"], answer: a };
  },
  forAdmin: row => ({ options: ["True", "False"], answer: row.answer }),
  forLearner: () => ({ options: ["True", "False"] }),
  mark: markChoice,
  yourAnswer: choiceYourAnswer,
  correctAnswer: choiceCorrectAnswer,
};
