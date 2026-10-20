import { plain } from "../text.js";

/** @typedef {{ options?: string[], answer?: number, spec?: Record<string, unknown>, error?: string }} CleanResult */

/**
 * What every question type provides. To add a type: write one file that exports one of these, then list it in index.js.
 * Nothing else needs to know about it, except the author's form and the learner's quiz screen in public/js.
 *
 * @typedef {Object} QuestionType
 * @property {string} key the name stored in the database
 * @property {string} label what authors see in the type menu
 * @property {(q: any) => CleanResult} clean validates what an author sent; returns the fields to store, or an error in plain words
 * @property {(row: any, spec: any) => object} forAdmin the fields staff see, answer key included
 * @property {(row: any, spec: any) => object} forLearner the fields a learner sees, never the key
 * @property {(row: any, spec: any, given: unknown) => { chosen: any, correct: boolean, key: object }} mark marks one answer; anything malformed counts as no answer
 * @property {(d: any) => string} yourAnswer plain-language text for what the learner answered, from a stored result
 * @property {(d: any) => string} correctAnswer plain-language text for the right answer, from a stored result
 */

/** Lower-cases and tidies text so "  Au " and "au" compare as equal. */
export const norm = s =>
  String(s ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export const LIMITS = { options: 6, accepted: 10, pairs: 8, text: 200, accept: 100, big: 1e12 };

/**
 * Cleans a list of option texts, dropping blanks but remembering where each survivor came from,
 * so "the correct one is option 3" still points at the right text after blanks are removed.
 * @returns {{ error: string } | { options: string[], map: Map<number, number> }}
 */
export function cleanOptions(raw) {
  const options = [];
  const map = new Map();
  (Array.isArray(raw) ? raw : []).slice(0, 12).forEach((o, i) => {
    const t = plain(o).slice(0, 300);
    if (t) {
      map.set(i, options.length);
      options.push(t);
    }
  });
  if (options.length < 2) return { error: "Give at least two answer options." };
  if (options.length > LIMITS.options) return { error: `Use at most ${LIMITS.options} answer options.` };
  if (new Set(options.map(norm)).size !== options.length)
    return { error: "Each answer option must be different." };
  return { options, map };
}
