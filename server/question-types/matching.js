import { createHash } from "node:crypto";
import { plain } from "../text.js";
import { norm, LIMITS } from "./shared.js";

/** @typedef {import("./shared.js").QuestionType} QuestionType */

// A fixed order that depends on the question and the text, so the choices look shuffled but never give the pairing away.
const hash = (id, s) => createHash("sha256").update(`${id}:${s}`).digest("hex");

/** Match each item with its pair. Right only if every pair is right. */
/** @type {QuestionType} */
export const matching = {
  key: "matching",
  label: "Matching",
  clean(q) {
    const pairs = (Array.isArray(q.pairs) ? q.pairs : []).slice(0, 12).map(p => ({
      left: plain(p?.left).slice(0, LIMITS.text),
      right: plain(p?.right).slice(0, LIMITS.text),
    }));
    if (pairs.length < 2 || pairs.length > LIMITS.pairs)
      return { error: `Give between 2 and ${LIMITS.pairs} pairs.` };
    if (pairs.some(p => !p.left || !p.right)) return { error: "Fill in both sides of every pair." };
    if (
      new Set(pairs.map(p => norm(p.left))).size !== pairs.length ||
      new Set(pairs.map(p => norm(p.right))).size !== pairs.length
    )
      return { error: "Each item and each match must be different." };
    return { spec: { pairs } };
  },
  forAdmin: (row, spec) => ({ pairs: spec.pairs }),
  forLearner: (row, spec) => ({
    items: spec.pairs.map(p => p.left),
    choices: spec.pairs.map(p => p.right).sort((a, b) => hash(row.id, a).localeCompare(hash(row.id, b))),
  }),
  mark(row, spec, given) {
    const list =
      Array.isArray(given) && given.length === spec.pairs.length
        ? given.map(g => (typeof g === "string" && g.trim() ? g.trim().slice(0, LIMITS.text) : null))
        : null;
    const chosen = list && list.some(Boolean) ? list : null;
    const correct =
      !!chosen && spec.pairs.every((p, i) => chosen[i] !== null && norm(chosen[i]) === norm(p.right));
    return { chosen, correct, key: { pairs: spec.pairs } };
  },
  yourAnswer: d =>
    d.chosen
      ? d.key.pairs.map((p, i) => `${p.left} → ${d.chosen[i] ?? "no answer"}`).join("; ")
      : "No answer",
  correctAnswer: d => d.key.pairs.map(p => `${p.left} → ${p.right}`).join("; "),
};
