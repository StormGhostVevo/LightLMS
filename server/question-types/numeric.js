import { LIMITS } from "./shared.js";

/** @typedef {import("./shared.js").QuestionType} QuestionType */

/** Reads "12.5", " 12.5 " or "1,000" (one thousand) as a number; anything else is no number. */
const asNumber = v => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/\s+/g, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ""); // 1,000 means one thousand
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null;
};

/** The learner types a number. Right if it is within the tolerance (0 means exact). */
/** @type {QuestionType} */
export const numeric = {
  key: "numeric",
  label: "Number",
  clean(q) {
    const value = Number(q.value);
    const tolerance =
      q.tolerance === undefined || q.tolerance === null || q.tolerance === "" ? 0 : Number(q.tolerance);
    if (
      q.value === "" ||
      q.value === null ||
      q.value === undefined ||
      !Number.isFinite(value) ||
      Math.abs(value) > LIMITS.big
    )
      return { error: "Enter the correct number." };
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > LIMITS.big)
      return { error: "The tolerance must be zero or more." };
    return { spec: { value, tolerance } };
  },
  forAdmin: (row, spec) => ({ value: spec.value, tolerance: spec.tolerance }),
  forLearner: () => ({}),
  mark(row, spec, given) {
    const n = asNumber(given);
    const chosen = n === null ? null : String(typeof given === "string" ? given.trim().slice(0, 40) : given);
    return {
      chosen,
      correct: n !== null && Math.abs(n - spec.value) <= spec.tolerance + 1e-9,
      key: { value: spec.value, tolerance: spec.tolerance },
    };
  },
  yourAnswer: d => (d.chosen === null || d.chosen === undefined ? "No answer" : String(d.chosen)),
  correctAnswer: d =>
    d.key.tolerance > 0 ? `${d.key.value} (give or take ${d.key.tolerance})` : String(d.key.value),
};
