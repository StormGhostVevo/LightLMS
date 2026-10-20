import { after } from "node:test";
import { openDb } from "../db.js";
import { createApp } from "../app.js";
import { hashPassword } from "../auth.js";
import { stubProvider } from "../ai.js";
import { cleanQuestion } from "../question-types/index.js";

/**
 * @typedef {{ status: number, body: any, setCookie: string | null }} Reply
 * @typedef {(path: string, opts?: { method?: string, body?: unknown }) => Promise<Reply>} Call
 */

export const PW = "correct-horse-battery";
export const SOURCE =
  "Safety basics\n\nAlways wear a helmet on site.\n\nReport hazards to your supervisor straight away.\n\nKeep walkways clear at all times.";

// Every test server is closed when the test file finishes.
const servers = [];
after(() =>
  servers.forEach(s => {
    s.closeAllConnections();
    s.close();
  }),
);
export const track = server => {
  servers.push(server);
  return server;
};

/**
 * Starts an app on a free port, with an admin, an author and a learner already created (all with the password PW).
 * @param {any} [ai] the AI provider; the offline stand-in by default
 */
export async function start(ai = stubProvider()) {
  const db = openDb(":memory:");
  const hash = await hashPassword(PW);
  for (const role of ["admin", "author", "learner"])
    db.prepare("INSERT INTO users (email, role, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
      `${role}@example.com`,
      role,
      hash,
      new Date().toISOString(),
    );
  const server = track(createApp({ db, config: {}, ai }).listen(0));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const base = `http://localhost:${port}`;

  /**
   * The raw response. `type: null` sends no content type, which is how a cross-site form post looks.
   * @param {string} path
   * @param {{ method?: string, body?: unknown, cookie?: string, type?: string | null }} [opts]
   */
  const raw = (path, { method = "GET", body, cookie, type = "application/json" } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(type ? { "content-type": type } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  /** @returns {Promise<Reply>} */
  const parse = async r => ({
    status: r.status,
    body: r.status === 204 ? null : await r.json(),
    setCookie: r.headers.get("set-cookie"),
  });
  /**
   * Signs in and returns a function that makes calls as that person.
   * @param {"admin" | "author" | "learner" | null} role null means signed out
   * @returns {Promise<Call>}
   */
  const as = async role => {
    let cookie;
    if (role) {
      const login = await parse(
        await raw("/api/auth/login", {
          method: "POST",
          body: { email: `${role}@example.com`, password: PW },
        }),
      );
      cookie = login.setCookie.split(";")[0];
    }
    return (path, opts = {}) => raw(path, { ...opts, cookie }).then(parse);
  };
  return {
    db,
    base,
    raw,
    parse,
    as,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof start>>} TestApp */

/** A published course drafted from SOURCE (one lesson and one draft placeholder question). */
export async function publishedCourse(/** @type {TestApp} */ s) {
  const author = await s.as("author");
  const {
    body: { id },
  } = await author("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } });
  await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} });
  return { author, id };
}

// A published course with 3 approved questions (correct option is always index 0 with the stub AI), learner enrolled.
export async function quizCourse(/** @type {TestApp} */ s, settings = {}) {
  const { author, id } = await publishedCourse(s);
  await author(`/api/admin/courses/${id}/quiz/generate`, { method: "POST", body: { count: 2 } });
  const full = (await author(`/api/admin/courses/${id}`)).body;
  for (const q of full.questions)
    await author(`/api/admin/questions/${q.id}`, { method: "PATCH", body: { status: "approved" } });
  await author(`/api/admin/courses/${id}`, { method: "PATCH", body: settings });
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["learner@example.com"] },
  });
  const answers = pick => Object.fromEntries(full.questions.map(q => [q.id, pick]));
  return { author, id, qids: full.questions.map(q => q.id), answers };
}

// Adds extra lessons straight into the database.
export const addLessons = (/** @type {TestApp} */ s, courseId, n) => {
  for (let i = 0; i < n; i++)
    s.db
      .prepare("INSERT INTO lessons (course_id, position, title, body) VALUES (?, ?, ?, '<p>x</p>')")
      .run(courseId, 10 + i, `Extra ${i}`);
};
export const lessonIds = async (/** @type {Call} */ learner, id) =>
  (await learner(`/api/courses/${id}/progress`)).body.lessons.map(l => l.id);

// Completes the course for a learner: tick every lesson, pass the quiz.
export async function complete(/** @type {Call} */ learner, id, answers) {
  for (const lid of await lessonIds(learner, id))
    await learner(`/api/courses/${id}/lessons/${lid}/complete`, { method: "POST", body: {} });
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
}
export const addUser = async (/** @type {TestApp} */ s, email, name = "") =>
  s.db
    .prepare(
      "INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, 'learner', ?, ?)",
    )
    .run(email, name, await hashPassword(PW), new Date().toISOString());
/** @returns {Promise<Call>} */
export const loginAs = async (/** @type {TestApp} */ s, email) => {
  const l = await s.parse(await s.raw("/api/auth/login", { method: "POST", body: { email, password: PW } }));
  const cookie = l.setCookie.split(";")[0];
  return (path, opts = {}) => s.raw(path, { ...opts, cookie }).then(s.parse);
};

export const DARK = { background: "#14171d", surface: "#1c212b", text: "#e8ebf1", link: "#6f9bff" };

// A 1x1 PNG. The server only looks at the first bytes of an upload to decide what it is.
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
export const b64 = b => b.toString("base64");

export const ONE_OF_EACH = {
  mcq: { type: "mcq", prompt: "Capital of France?", options: ["Paris", "Rome", "Madrid"], answer: 0 },
  true_false: { type: "true_false", prompt: "The sun is a star.", answer: true },
  multiple_response: {
    type: "multiple_response",
    prompt: "Which are primary colours?",
    options: ["Red", "Green", "Orange", "Blue"],
    answers: [0, 1, 3],
  },
  short_answer: {
    type: "short_answer",
    prompt: "What is the chemical symbol for gold?",
    accepted: ["Au", "gold symbol: Au"],
  },
  numeric: { type: "numeric", prompt: "What is 100 divided by 8?", value: 12.5, tolerance: 0.1 },
  matching: {
    type: "matching",
    prompt: "Match the country to its capital.",
    pairs: [
      { left: "France", right: "Paris" },
      { left: "Italy", right: "Rome" },
      { left: "Spain", right: "Madrid" },
    ],
  },
};
/** A stored question row, as the database would hold it, built from a question as an author would write it. */
export const rowFor = q => {
  const v = cleanQuestion(q).value;
  return {
    id: 7,
    type: v.type,
    prompt: v.prompt,
    options: JSON.stringify(v.options),
    answer: v.answer,
    spec: JSON.stringify(v.spec),
    explanation: "",
  };
};
