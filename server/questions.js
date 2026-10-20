import { createHash } from "node:crypto";
import { plain } from "./text.js";

// Every question type lives here: what a valid question looks like, how an answer is marked, and how to show it.
// Marking is all or nothing. A question is right only if the whole answer is right.
export const TYPES = {
  mcq: "Multiple choice",
  true_false: "True or false",
  multiple_response: "Multiple response (select all that apply)",
  short_answer: "Short answer",
  numeric: "Number",
  matching: "Matching",
};

const norm = s => String(s ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const LIMITS = { options: 6, accepted: 10, pairs: 8, text: 200, accept: 100, big: 1e12 };

// Cleans a list of option texts, dropping blanks but remembering where each survivor came from,
// so "the correct one is option 3" still points at the right text after blanks are removed.
function cleanOptions(raw) {
  const options = [], map = new Map();
  (Array.isArray(raw) ? raw : []).slice(0, 12).forEach((o, i) => { const t = plain(o).slice(0, 300); if (t) { map.set(i, options.length); options.push(t); } });
  if (options.length < 2) return { error: "Give at least two answer options." };
  if (options.length > LIMITS.options) return { error: `Use at most ${LIMITS.options} answer options.` };
  if (new Set(options.map(norm)).size !== options.length) return { error: "Each answer option must be different." };
  return { options, map };
}

// Turns whatever was sent into a valid question, or says what is wrong in plain words.
// Returns { value: { type, prompt, explanation, options, answer, spec } } or { error }.
export function cleanQuestion(input) {
  const q = input || {};
  const type = q.type ?? "mcq";
  if (!TYPES[type]) return { error: "Choose one of the listed question types." };
  const prompt = plain(q.prompt).slice(0, 500);
  if (!prompt) return { error: "Write the question." };
  const base = { type, prompt, explanation: plain(q.explanation).slice(0, 500), options: [], answer: 0, spec: {} };

  if (type === "mcq") {
    const o = cleanOptions(q.options);
    if (o.error) return o;
    if (!Number.isInteger(q.answer) || !o.map.has(q.answer)) return { error: "Select which option is correct." };
    return { value: { ...base, options: o.options, answer: o.map.get(q.answer) } };
  }
  if (type === "true_false") {
    const a = q.answer === true ? 0 : q.answer === false ? 1 : q.answer;   // 0 is True, 1 is False
    if (a !== 0 && a !== 1) return { error: "Say whether the statement is true or false." };
    return { value: { ...base, options: ["True", "False"], answer: a } };
  }
  if (type === "multiple_response") {
    const o = cleanOptions(q.options);
    if (o.error) return o;
    const picked = [...new Set((Array.isArray(q.answers) ? q.answers : []).filter(i => Number.isInteger(i) && o.map.has(i)).map(i => o.map.get(i)))].sort((a, b) => a - b);
    if (!picked.length) return { error: "Select at least one correct option." };
    return { value: { ...base, options: o.options, spec: { answers: picked } } };
  }
  if (type === "short_answer") {
    const seen = new Set(), accepted = [];
    for (const a of (Array.isArray(q.accepted) ? q.accepted : []).slice(0, 30)) {
      const t = plain(a).slice(0, LIMITS.accept);
      if (t && !seen.has(norm(t))) { seen.add(norm(t)); accepted.push(t); }
    }
    if (!accepted.length) return { error: "Give at least one accepted answer." };
    if (accepted.length > LIMITS.accepted) return { error: `Use at most ${LIMITS.accepted} accepted answers.` };
    return { value: { ...base, spec: { accepted } } };
  }
  if (type === "numeric") {
    const value = Number(q.value), tolerance = q.tolerance === undefined || q.tolerance === null || q.tolerance === "" ? 0 : Number(q.tolerance);
    if (q.value === "" || q.value === null || q.value === undefined || !Number.isFinite(value) || Math.abs(value) > LIMITS.big) return { error: "Enter the correct number." };
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > LIMITS.big) return { error: "The tolerance must be zero or more." };
    return { value: { ...base, spec: { value, tolerance } } };
  }
  // matching
  const pairs = (Array.isArray(q.pairs) ? q.pairs : []).slice(0, 12).map(p => ({ left: plain(p?.left).slice(0, LIMITS.text), right: plain(p?.right).slice(0, LIMITS.text) }));
  if (pairs.length < 2 || pairs.length > LIMITS.pairs) return { error: `Give between 2 and ${LIMITS.pairs} pairs.` };
  if (pairs.some(p => !p.left || !p.right)) return { error: "Fill in both sides of every pair." };
  if (new Set(pairs.map(p => norm(p.left))).size !== pairs.length || new Set(pairs.map(p => norm(p.right))).size !== pairs.length)
    return { error: "Each item and each match must be different." };
  return { value: { ...base, spec: { pairs } } };
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
  return db.prepare("INSERT INTO questions (course_id, position, type, prompt, options, answer, spec, explanation, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(courseId, position, q.type, q.prompt, JSON.stringify(q.options), q.answer, JSON.stringify(q.spec), q.explanation, source, status).lastInsertRowid;
}

// ---- what staff see: the whole question, answer key included ----
export function toAdmin(r) {
  const spec = JSON.parse(r.spec || "{}"), out = { id: r.id, type: r.type, prompt: r.prompt };
  if (r.type === "mcq") Object.assign(out, { options: JSON.parse(r.options), answer: r.answer });
  else if (r.type === "true_false") Object.assign(out, { options: ["True", "False"], answer: r.answer });
  else if (r.type === "multiple_response") Object.assign(out, { options: JSON.parse(r.options), answers: spec.answers });
  else if (r.type === "short_answer") out.accepted = spec.accepted;
  else if (r.type === "numeric") Object.assign(out, { value: spec.value, tolerance: spec.tolerance });
  else out.pairs = spec.pairs;
  return Object.assign(out, { explanation: r.explanation, source: r.source, status: r.status });
}

// ---- what a learner sees: no answer key. Matching choices are shuffled in a fixed order that doesn't give the pairing away. ----
export function forLearner(r) {
  const out = { id: r.id, type: r.type, prompt: r.prompt };
  if (["mcq", "true_false", "multiple_response"].includes(r.type)) out.options = r.type === "true_false" ? ["True", "False"] : JSON.parse(r.options);
  if (r.type === "matching") {
    const { pairs } = JSON.parse(r.spec);
    out.items = pairs.map(p => p.left);
    out.choices = pairs.map(p => p.right).sort((a, b) => hash(r.id, a).localeCompare(hash(r.id, b)));
  }
  return out;
}
const hash = (id, s) => createHash("sha256").update(`${id}:${s}`).digest("hex");

// ---- marking ----
const asNumber = v => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/\s+/g, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");        // 1,000 means one thousand
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null;
};

// Marks one answer and returns the snapshot stored with the attempt: the question as it was, what was given, and the key.
// Anything missing or malformed counts as no answer.
export function mark(r, given) {
  const spec = JSON.parse(r.spec || "{}"), options = r.type === "true_false" ? ["True", "False"] : JSON.parse(r.options);
  const d = { id: r.id, type: r.type, prompt: r.prompt, options, chosen: null, correct: false, key: {}, explanation: r.explanation };
  if (r.type === "mcq" || r.type === "true_false") {
    d.key = { answer: r.answer };
    d.chosen = Number.isInteger(given) && given >= 0 && given < options.length ? given : null;
    d.correct = d.chosen === r.answer;
  } else if (r.type === "multiple_response") {
    d.key = { answers: spec.answers };
    const picked = Array.isArray(given) ? [...new Set(given.filter(i => Number.isInteger(i) && i >= 0 && i < options.length))].sort((a, b) => a - b) : [];
    d.chosen = picked.length ? picked : null;
    d.correct = !!d.chosen && d.chosen.length === spec.answers.length && d.chosen.every((v, i) => v === spec.answers[i]);
  } else if (r.type === "short_answer") {
    d.key = { accepted: spec.accepted };
    const t = typeof given === "string" ? given.trim().slice(0, LIMITS.text) : "";
    d.chosen = t || null;
    d.correct = !!t && spec.accepted.some(a => norm(a) === norm(t));
  } else if (r.type === "numeric") {
    d.key = { value: spec.value, tolerance: spec.tolerance };
    const n = asNumber(given);
    d.chosen = n === null ? null : String(typeof given === "string" ? given.trim().slice(0, 40) : given);
    d.correct = n !== null && Math.abs(n - spec.value) <= spec.tolerance + 1e-9;
  } else {
    d.key = { pairs: spec.pairs };
    const list = Array.isArray(given) && given.length === spec.pairs.length ? given.map(g => (typeof g === "string" && g.trim() ? g.trim().slice(0, LIMITS.text) : null)) : null;
    d.chosen = list && list.some(Boolean) ? list : null;
    d.correct = !!d.chosen && spec.pairs.every((p, i) => d.chosen[i] !== null && norm(d.chosen[i]) === norm(p.right));
  }
  return d;
}

// ---- plain-language text for a stored result (works for attempts taken before types existed, which have no `type`) ----
export function yourAnswer(d) {
  if (d.chosen === null || d.chosen === undefined) return "No answer";
  switch (d.type || "mcq") {
    case "multiple_response": return d.chosen.map(i => d.options[i]).join("; ");
    case "matching": return d.key.pairs.map((p, i) => `${p.left} → ${d.chosen[i] ?? "no answer"}`).join("; ");
    case "short_answer": case "numeric": return String(d.chosen);
    default: return d.options[d.chosen];
  }
}
export function correctAnswer(d) {
  const k = d.key || {};
  switch (d.type || "mcq") {
    case "multiple_response": return k.answers.map(i => d.options[i]).join("; ");
    case "matching": return k.pairs.map(p => `${p.left} → ${p.right}`).join("; ");
    case "short_answer": return k.accepted.join(" or ");
    case "numeric": return k.tolerance > 0 ? `${k.value} (give or take ${k.tolerance})` : String(k.value);
    default: return d.options[k.answer ?? d.answer];
  }
}
