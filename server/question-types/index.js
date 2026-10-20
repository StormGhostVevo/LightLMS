import { plain } from "../text.js";
import { mcq } from "./mcq.js";
import { trueFalse } from "./true-false.js";
import { multipleResponse } from "./multiple-response.js";
import { shortAnswer } from "./short-answer.js";
import { numeric } from "./numeric.js";
import { matching } from "./matching.js";

// Every question type, in the order authors see them. To add a type, write its file and list it here.
// Marking is all or nothing: a question is right only if the whole answer is right.
const ALL = [mcq, trueFalse, multipleResponse, shortAnswer, numeric, matching];

/** @type {Record<string, import("./shared.js").QuestionType>} */
export const REGISTRY = Object.fromEntries(ALL.map(t => [t.key, t]));
/** Type key to label, for menus and validation. */
export const TYPES = Object.fromEntries(ALL.map(t => [t.key, t.label]));

// Attempts taken before there were question types have no `type`; they are multiple choice.
const typeOf = d => REGISTRY[d.type || "mcq"] ?? mcq;

/**
 * Turns whatever was sent into a valid question, or says what is wrong in plain words.
 * @returns {{ value?: { type: string, prompt: string, explanation: string, options: string[], answer: number, spec: any }, error?: string }}
 */
export function cleanQuestion(input) {
  const q = input || {};
  const type = q.type ?? "mcq";
  const t = REGISTRY[type];
  if (!t) return { error: "Choose one of the listed question types." };
  const prompt = plain(q.prompt).slice(0, 500);
  if (!prompt) return { error: "Write the question." };
  const r = t.clean(q);
  if (r.error) return { error: r.error };
  return {
    value: {
      type,
      prompt,
      explanation: plain(q.explanation).slice(0, 500),
      options: r.options ?? [],
      answer: r.answer ?? 0,
      spec: r.spec ?? {},
    },
  };
}

// The AI's output goes through the same checks. Questions that fail are left out and flagged for a person.
export function tidyQuestions(list, flags = []) {
  const out = [];
  for (const q of (list || []).slice(0, 20)) {
    const r = cleanQuestion(q);
    if (r.value) out.push(r.value);
    else flags.push(`A question was left out: ${r.error.replace(/\.$/, "").toLowerCase()}.`);
  }
  return out;
}

export function insertQuestion(db, courseId, position, q, source, status = "draft") {
  return db
    .prepare(
      "INSERT INTO questions (course_id, position, type, prompt, options, answer, spec, explanation, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      courseId,
      position,
      q.type,
      q.prompt,
      JSON.stringify(q.options),
      q.answer,
      JSON.stringify(q.spec),
      q.explanation,
      source,
      status,
    ).lastInsertRowid;
}

const specOf = row => JSON.parse(row.spec || "{}");

/** What staff see: the whole question, answer key included. */
export function toAdmin(row) {
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    ...REGISTRY[row.type].forAdmin(row, specOf(row)),
    explanation: row.explanation,
    source: row.source,
    status: row.status,
  };
}

/** What a learner sees: never the answer key. */
export function forLearner(row) {
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    ...REGISTRY[row.type].forLearner(row, specOf(row)),
  };
}

/**
 * Marks one answer and returns the snapshot stored with the attempt: the question as it was, what was given, and the key.
 * Anything missing or malformed counts as no answer.
 */
export function mark(row, given) {
  const r = REGISTRY[row.type].mark(row, specOf(row), given);
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    options: JSON.parse(row.options),
    ...r,
    explanation: row.explanation,
  };
}

/** Plain-language text for a stored result. */
export const yourAnswer = d => typeOf(d).yourAnswer(d);
export const correctAnswer = d => typeOf(d).correctAnswer(d);
