import { plain } from "../text.js";
import { norm, LIMITS } from "./shared.js";

/** @typedef {import("./shared.js").QuestionType} QuestionType */

/** The learner types a word or phrase. Capital letters and extra spaces are ignored. */
/** @type {QuestionType} */
export const shortAnswer = {
  key: "short_answer",
  label: "Short answer",
  clean(q) {
    const seen = new Set();
    const accepted = [];
    for (const a of (Array.isArray(q.accepted) ? q.accepted : []).slice(0, 30)) {
      const t = plain(a).slice(0, LIMITS.accept);
      if (t && !seen.has(norm(t))) {
        seen.add(norm(t));
        accepted.push(t);
      }
    }
    if (!accepted.length) return { error: "Give at least one accepted answer." };
    if (accepted.length > LIMITS.accepted)
      return { error: `Use at most ${LIMITS.accepted} accepted answers.` };
    return { spec: { accepted } };
  },
  forAdmin: (row, spec) => ({ accepted: spec.accepted }),
  forLearner: () => ({}),
  mark(row, spec, given) {
    const t = typeof given === "string" ? given.trim().slice(0, LIMITS.text) : "";
    return {
      chosen: t || null,
      correct: !!t && spec.accepted.some(a => norm(a) === norm(t)),
      key: { accepted: spec.accepted },
    };
  },
  yourAnswer: d => (d.chosen ? String(d.chosen) : "No answer"),
  correctAnswer: d => d.key.accepted.join(" or "),
};
