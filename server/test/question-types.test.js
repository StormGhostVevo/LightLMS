import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanQuestion, mark, forLearner, yourAnswer, correctAnswer, TYPES } from "../questions.js";
import { start, publishedCourse, quizCourse, ONE_OF_EACH, rowFor } from "./helpers.js";

test("question types: every type validates, and each rejects what it should", () => {
  for (const [type, q] of Object.entries(ONE_OF_EACH)) assert.ok(cleanQuestion(q).value, type);
  assert.deepEqual(Object.keys(ONE_OF_EACH), Object.keys(TYPES));
  const err = q => cleanQuestion({ prompt: "Q?", ...q }).error;
  assert.ok(err({ type: "poem" }));
  assert.ok(err({ type: "true_false" })); // must say true or false
  assert.ok(err({ type: "true_false", answer: 2 }));
  assert.ok(err({ type: "multiple_response", options: ["a", "b"], answers: [] })); // at least one correct
  assert.ok(err({ type: "multiple_response", options: ["a", "b"], answers: [5] }));
  assert.ok(err({ type: "short_answer", accepted: ["", "  "] }));
  assert.ok(err({ type: "numeric", value: "abc" }));
  assert.ok(err({ type: "numeric", value: "" }));
  assert.ok(err({ type: "numeric", value: 5, tolerance: -1 }));
  assert.ok(err({ type: "matching", pairs: [{ left: "a", right: "b" }] })); // needs two pairs
  assert.ok(
    err({
      type: "matching",
      pairs: [
        { left: "a", right: "x" },
        { left: "b", right: "x" },
      ],
    }),
  ); // matches must differ
  assert.ok(
    err({
      type: "matching",
      pairs: [
        { left: "a", right: "x" },
        { left: "", right: "y" },
      ],
    }),
  );
  assert.ok(err({ type: "mcq", options: ["a"], answer: 0 }));
  assert.equal(cleanQuestion({ prompt: "", type: "mcq" }).error, "Write the question.");
});

test("question types: option positions survive blank options being dropped", () => {
  const mcq = cleanQuestion({ prompt: "Q?", options: ["", "Wrong", "", "Right"], answer: 3 }).value;
  assert.deepEqual([mcq.options, mcq.answer], [["Wrong", "Right"], 1]);
  const multi = cleanQuestion({
    type: "multiple_response",
    prompt: "Q?",
    options: ["A", "", "B", "C"],
    answers: [2, 3, 3],
  }).value;
  assert.deepEqual(
    [multi.options, multi.spec.answers],
    [
      ["A", "B", "C"],
      [1, 2],
    ],
  ); // duplicates folded, positions remapped
});

test("question types: marking is all or nothing, and forgiving about case, spaces and number formats", () => {
  const m = (type, given) => mark(rowFor(ONE_OF_EACH[type]), given);
  assert.equal(m("mcq", 0).correct, true);
  assert.equal(m("mcq", 1).correct, false);
  assert.equal(m("mcq", "0").correct, false); // a string isn't an option number
  assert.equal(m("true_false", 0).correct, true);
  assert.equal(m("true_false", 1).correct, false);
  assert.equal(m("multiple_response", [3, 0, 1]).correct, true); // order doesn't matter
  assert.equal(m("multiple_response", [0, 1]).correct, false); // missing one
  assert.equal(m("multiple_response", [0, 1, 2, 3]).correct, false); // one too many
  assert.equal(m("multiple_response", []).chosen, null);
  for (const ok of ["Au", "  au ", "AU", "gold   symbol:  au"])
    assert.equal(m("short_answer", ok).correct, true, ok);
  for (const no of ["Ag", "", "   ", 5, null]) assert.equal(m("short_answer", no).correct, false, String(no));
  for (const ok of [12.5, "12.5", " 12.55 ", "12.4", "12.6"])
    assert.equal(m("numeric", ok).correct, true, String(ok));
  for (const no of ["12.7", "twelve", "", "1e3", NaN, "12.5.1"])
    assert.equal(m("numeric", no).correct, false, String(no));
  assert.equal(mark(rowFor({ type: "numeric", prompt: "Q?", value: 1000 }), "1,000").correct, true); // thousands separator
  assert.equal(mark(rowFor({ type: "numeric", prompt: "Q?", value: 1000 }), "1,00").correct, false);
  assert.equal(mark(rowFor({ type: "numeric", prompt: "Q?", value: 3 }), "3.0").correct, true); // no tolerance: exact
  assert.equal(m("matching", ["Paris", "Rome", "Madrid"]).correct, true);
  assert.equal(m("matching", ["paris", " Rome ", "MADRID"]).correct, true);
  assert.equal(m("matching", ["Rome", "Paris", "Madrid"]).correct, false);
  assert.equal(m("matching", ["Paris", "Rome", null]).correct, false);
  assert.equal(m("matching", ["Paris", "Rome"]).chosen, null); // wrong length: no answer
  assert.equal(m("matching", "Paris").chosen, null);
});

test("question types: learners never get the key; matching choices are a shuffled version of the matches", () => {
  for (const [type, q] of Object.entries(ONE_OF_EACH)) {
    const l = forLearner(rowFor(q));
    for (const secret of [
      "answer",
      "answers",
      "accepted",
      "value",
      "tolerance",
      "pairs",
      "explanation",
      "spec",
    ])
      assert.ok(!(secret in l), `${type} leaks ${secret}`);
  }
  const l = forLearner(rowFor(ONE_OF_EACH.matching));
  assert.deepEqual(l.items, ["France", "Italy", "Spain"]);
  assert.deepEqual([...l.choices].sort(), ["Madrid", "Paris", "Rome"]);
  assert.deepEqual(forLearner(rowFor(ONE_OF_EACH.matching)).choices, l.choices); // stable between requests
  assert.deepEqual(forLearner(rowFor(ONE_OF_EACH.true_false)).options, ["True", "False"]);
});

test("question types: result text for every type, and for attempts stored before types existed", () => {
  const m = (type, given) => {
    const d = mark(rowFor(ONE_OF_EACH[type]), given);
    return [yourAnswer(d), correctAnswer(d)];
  };
  assert.deepEqual(m("mcq", 1), ["Rome", "Paris"]);
  assert.deepEqual(m("mcq", undefined), ["No answer", "Paris"]);
  assert.deepEqual(m("true_false", 1), ["False", "True"]);
  assert.deepEqual(m("multiple_response", [0, 2]), ["Red; Orange", "Red; Green; Blue"]);
  assert.deepEqual(m("short_answer", "ag"), ["ag", "Au or gold symbol: Au"]);
  assert.deepEqual(m("numeric", "12"), ["12", "12.5 (give or take 0.1)"]);
  assert.deepEqual(m("matching", ["Paris", "Madrid", null]), [
    "France → Paris; Italy → Madrid; Spain → no answer",
    "France → Paris; Italy → Rome; Spain → Madrid",
  ]);
  const legacy = {
    id: 1,
    prompt: "Old?",
    options: ["a", "b"],
    chosen: 1,
    answer: 0,
    correct: false,
    explanation: "",
  }; // the shape from before question types
  assert.deepEqual([yourAnswer(legacy), correctAnswer(legacy)], ["b", "a"]);
});

test("question types: a whole quiz with every type, taken by a learner, over the API", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  const learner = await s.as("learner");
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["learner@example.com"] },
  });
  await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { showAnswers: "always" } });
  const made = {};
  for (const [type, q] of Object.entries(ONE_OF_EACH)) {
    const r = await author(`/api/admin/courses/${id}/questions`, {
      method: "POST",
      body: { ...q, explanation: `Because ${type}` },
    });
    assert.equal(r.status, 201, `${type}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.type, type);
    made[type] = r.body.id;
  }
  const admin = (await author(`/api/admin/courses/${id}`)).body.questions.filter(q => q.source === "manual"); // the AI-drafted starter question is a draft
  assert.deepEqual(
    admin.map(q => q.type),
    Object.keys(ONE_OF_EACH),
  );
  assert.deepEqual(admin.find(q => q.type === "numeric").value, 12.5);

  const view = (await learner(`/api/courses/${id}`)).body.questions;
  assert.equal(view.length, 6);
  assert.ok(
    view.every(
      q => !("answer" in q) && !("answers" in q) && !("accepted" in q) && !("pairs" in q) && !("value" in q),
    ),
  );
  const choices = view.find(q => q.type === "matching").choices;

  const right = {
    [made.mcq]: 0,
    [made.true_false]: 0,
    [made.multiple_response]: [0, 1, 3],
    [made.short_answer]: "  au",
    [made.numeric]: "12.55",
    [made.matching]: ["Paris", "Rome", "Madrid"],
  };
  assert.ok(["Paris", "Rome", "Madrid"].every(c => choices.includes(c)));
  const all = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: right } });
  assert.deepEqual([all.body.score, all.body.total, all.body.passed], [6, 6, true]);

  const mixed = await learner(`/api/courses/${id}/quiz`, {
    method: "POST",
    body: {
      answers: {
        ...right,
        [made.multiple_response]: [0, 1],
        [made.matching]: ["Rome", "Paris", "Madrid"],
        [made.numeric]: "abc",
      },
    },
  });
  assert.deepEqual([mixed.body.score, mixed.body.percent], [3, 50]);
  const byType = Object.fromEntries(mixed.body.results.map(r => [r.type, r]));
  assert.equal(byType.multiple_response.yourAnswer, "Red; Green");
  assert.equal(byType.multiple_response.correctAnswer, "Red; Green; Blue");
  assert.equal(byType.multiple_response.explanation, "Because multiple_response");
  assert.equal(byType.numeric.yourAnswer, "No answer");
  assert.equal(byType.matching.yourAnswer, "France → Rome; Italy → Paris; Spain → Madrid");
  assert.equal(byType.mcq.answer, 0); // option number still sent for multiple choice
  assert.ok(!("answer" in byType.short_answer));
  s.close();
});

test("question types: answers stay hidden until the course allows them, for every type", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  const learner = await s.as("learner");
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["learner@example.com"] },
  });
  for (const q of Object.values(ONE_OF_EACH))
    await author(`/api/admin/courses/${id}/questions`, { method: "POST", body: q });
  const r = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } }); // default rule: after pass, and this is a fail
  assert.equal(r.body.passed, false);
  assert.ok(r.body.results.every(x => !("correctAnswer" in x) && !("answer" in x) && !("explanation" in x)));
  assert.ok(r.body.results.every(x => x.yourAnswer === "No answer"));
  s.close();
});

test("question types: editing a question, changing its type, and the errors you get", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  const add = body => author(`/api/admin/courses/${id}/questions`, { method: "POST", body });
  assert.equal((await add({ type: "numeric", prompt: "Q?", value: "x" })).status, 400);
  assert.equal((await add({ type: "matching", prompt: "Q?", pairs: [] })).status, 400);
  assert.equal((await add({ type: "wat", prompt: "Q?" })).status, 400);
  const q = (await add(ONE_OF_EACH.numeric)).body;
  const edit = body => author(`/api/admin/questions/${q.id}`, { method: "PATCH", body });
  const t = await edit({ tolerance: 1 }); // partial edit keeps the rest
  assert.deepEqual([t.body.value, t.body.tolerance, t.body.prompt], [12.5, 1, "What is 100 divided by 8?"]);
  assert.equal((await edit({ status: "draft" })).body.status, "draft");
  assert.equal((await edit({ value: "nope" })).status, 400);
  assert.equal((await edit({ type: "short_answer" })).status, 400); // new type needs its own answer
  const to = await edit({ type: "short_answer", accepted: ["twelve and a half"] });
  assert.deepEqual(
    [to.status, to.body.type, to.body.accepted, "value" in to.body],
    [200, "short_answer", ["twelve and a half"], false],
  );
  const tf = await edit({ type: "true_false", answer: false });
  assert.deepEqual([tf.body.type, tf.body.answer, tf.body.options], ["true_false", 1, ["True", "False"]]);
  s.close();
});

test("question types: AI quiz generation can ask for any mix of types, and bad requests are refused", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  const gen = body => author(`/api/admin/courses/${id}/quiz/generate`, { method: "POST", body });
  assert.equal((await gen({ count: 3, types: ["poem"] })).status, 400);
  assert.equal((await gen({ count: 3, types: [] })).status, 400);
  assert.equal((await gen({ count: 3, types: "mcq" })).status, 400);
  const r = await gen({ count: 6, types: Object.keys(TYPES) });
  assert.deepEqual([r.status, r.body.added], [201, 6]);
  assert.ok(r.body.flags.some(f => /placeholder/i.test(f))); // the AI's own notes reach the author
  const full = (await author(`/api/admin/courses/${id}`)).body.questions.filter(q => q.source === "ai");
  assert.deepEqual([...new Set(full.map(q => q.type))].sort(), Object.keys(TYPES).sort());
  assert.ok(full.every(q => q.status === "draft"));
  assert.equal((await gen({ count: 2 })).body.added, 2); // no types: multiple choice, as before
  s.close();
});

test("question types: attempts taken before types existed still display and still count in the gradebook", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  const learner = await s.as("learner");
  const uid = s.db.prepare("SELECT id FROM users WHERE email = 'learner@example.com'").pluck().get();
  const legacy = [
    {
      id: 1,
      prompt: "Old question?",
      options: ["x", "y"],
      chosen: 1,
      answer: 0,
      correct: false,
      explanation: "Because.",
    },
  ];
  const info = s.db
    .prepare(
      "INSERT INTO attempts (course_id, user_id, score, total, percent, passed, pass_mark, detail, submitted_at) VALUES (?, ?, 0, 1, 0, 0, 70, ?, ?)",
    )
    .run(id, uid, JSON.stringify(legacy), new Date().toISOString());
  const a = await learner(`/api/attempts/${info.lastInsertRowid}`);
  assert.deepEqual([a.status, a.body.results[0].type, a.body.results[0].yourAnswer], [200, "mcq", "y"]);
  const staff = (await author(`/api/admin/courses/${id}/users/${uid}/attempts`)).body[0].results[0];
  assert.deepEqual([staff.correctAnswer, staff.answer, staff.explanation], ["x", 0, "Because."]);
  assert.ok((await author(`/api/admin/courses/${id}/gradebook`)).body.questions.length >= 1);
  s.close();
});
