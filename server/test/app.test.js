import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";
import { createApp } from "../app.js";
import { stubProvider, tidyQuestions, cleanBody } from "../ai.js";

const TOKEN = "test-token-test-token-1234";
const SOURCE = "Safety basics\n\nAlways wear a helmet on site.\n\nReport hazards to your supervisor straight away.\n\nKeep walkways clear at all times.";

const servers = [];
after(() => servers.forEach(s => { s.closeAllConnections(); s.close(); }));

async function start(ai = stubProvider()) {
  const app = createApp({ db: openDb(":memory:"), config: { adminToken: TOKEN }, ai });
  const server = app.listen(0);
  servers.push(server);
  const base = `http://localhost:${server.address().port}`;
  const call = (path, { method = "GET", body, auth = true } = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: body && JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: r.status === 204 ? null : await r.json() }));
  return { call, close: () => { server.closeAllConnections(); server.close(); } };
}

test("authoring routes need the token", async () => {
  const s = await start();
  assert.equal((await s.call("/api/admin/courses", { auth: false })).status, 401);
  s.close();
});

test("draft, approve, publish, learner quiz never leaks answers", async () => {
  const s = await start();
  const made = await s.call("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } });
  assert.equal(made.status, 201);
  const id = made.body.id;
  assert.equal((await s.call(`/api/courses/${id}`)).status, 404); // unpublished
  const full = (await s.call(`/api/admin/courses/${id}`)).body;
  assert.ok(full.lessons.length >= 1 && full.questions.every(q => q.status === "draft" && q.source === "ai"));
  await s.call(`/api/admin/questions/${full.questions[0].id}`, { method: "PATCH", body: { status: "approved" } });
  await s.call(`/api/admin/courses/${id}/publish`, { method: "POST" });
  const learner = (await s.call(`/api/courses/${id}`, { auth: false })).body;
  assert.equal(learner.questions.length, 1); // only the approved one
  assert.ok(!("answer" in learner.questions[0]));
  const marked = (await s.call(`/api/courses/${id}/quiz`, { method: "POST", auth: false, body: { answers: { [learner.questions[0].id]: 0 } } })).body;
  assert.deepEqual([marked.score, marked.total], [1, 1]);
  s.close();
});

test("generating a quiz adds draft questions", async () => {
  const s = await start();
  const { body: { id } } = await s.call("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } });
  const r = await s.call(`/api/admin/courses/${id}/quiz/generate`, { method: "POST", body: { count: 2 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.added, 2);
  s.close();
});

test("too-short source is refused and AI off returns 503", async () => {
  const s = await start();
  assert.equal((await s.call("/api/admin/ai/draft-course", { method: "POST", body: { text: "hi" } })).status, 400);
  s.close();
  const off = await start({ name: "off" });
  assert.equal((await off.call("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } })).status, 503);
  off.close();
});

test("tidyQuestions drops bad questions; cleanBody strips scripts", () => {
  const flags = [];
  const out = tidyQuestions([
    { prompt: "Ok?", options: ["a", "b"], answer: 1, explanation: "" },
    { prompt: "Bad index", options: ["a", "b"], answer: 5, explanation: "" },
    { prompt: "Dupes", options: ["a", "a"], answer: 0, explanation: "" },
  ], flags);
  assert.equal(out.length, 1);
  assert.equal(flags.length, 2);
  assert.ok(!cleanBody('<p>hi</p><script>alert(1)</script><a href="javascript:x">l</a>').includes("script"));
});
