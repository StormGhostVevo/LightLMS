import { test } from "node:test";
import assert from "node:assert/strict";
import { start, SOURCE, publishedCourse, quizCourse, addLessons, lessonIds } from "./helpers.js";

test("authoring needs an author or admin; learners and signed-out users are refused", async () => {
  const s = await start();
  assert.equal((await (await s.as(null))("/api/admin/courses")).status, 401);
  assert.equal((await (await s.as("learner"))("/api/admin/courses")).status, 403);
  assert.equal((await (await s.as("author"))("/api/admin/courses")).status, 200);
  s.close();
});

test("draft, approve, publish, learner quiz never leaks answers", async () => {
  const s = await start();
  const author = await s.as("author"),
    learner = await s.as("learner"),
    out = await s.as(null);
  const made = await author("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } });
  assert.equal(made.status, 201);
  const id = made.body.id;
  assert.equal((await learner(`/api/courses/${id}`)).status, 404); // unpublished
  const full = (await author(`/api/admin/courses/${id}`)).body;
  assert.ok(full.lessons.length >= 1 && full.questions.every(q => q.status === "draft" && q.source === "ai"));
  await author(`/api/admin/questions/${full.questions[0].id}`, {
    method: "PATCH",
    body: { status: "approved" },
  });
  await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} });
  assert.equal((await out(`/api/courses/${id}`)).status, 401);
  assert.equal((await learner(`/api/courses/${id}`)).status, 404); // published but not enrolled
  await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["learner@example.com"] },
  });
  const view = (await learner(`/api/courses/${id}`)).body;
  assert.equal(view.questions.length, 1); // only the approved one
  assert.ok(!("answer" in view.questions[0]));
  const marked = (
    await learner(`/api/courses/${id}/quiz`, {
      method: "POST",
      body: { answers: { [view.questions[0].id]: 0 } },
    })
  ).body;
  assert.deepEqual([marked.score, marked.total], [1, 1]);
  s.close();
});

test("generating a quiz adds draft questions", async () => {
  const s = await start();
  const author = await s.as("author");
  const {
    body: { id },
  } = await author("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } });
  const r = await author(`/api/admin/courses/${id}/quiz/generate`, { method: "POST", body: { count: 2 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.added, 2);
  s.close();
});

test("too-short source is refused and AI off returns 503", async () => {
  const s = await start();
  assert.equal(
    (await (await s.as("author"))("/api/admin/ai/draft-course", { method: "POST", body: { text: "hi" } }))
      .status,
    400,
  );
  const off = await start({ name: "off" });
  assert.equal(
    (await (await off.as("author"))("/api/admin/ai/draft-course", { method: "POST", body: { text: SOURCE } }))
      .status,
    503,
  );
});

test("enrolment: manual courses need staff to enrol; results report unknown emails; unenrol removes access", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  const learner = await s.as("learner");
  assert.deepEqual((await learner("/api/courses")).body, []);
  assert.equal((await learner(`/api/courses/${id}/enrol`, { method: "POST", body: {} })).status, 404); // manual, not open
  assert.equal(
    (
      await learner(`/api/admin/courses/${id}/enrolments`, {
        method: "POST",
        body: { emails: ["learner@example.com"] },
      })
    ).status,
    403,
  );
  const r = await author(`/api/admin/courses/${id}/enrolments`, {
    method: "POST",
    body: { emails: ["Learner@example.com", "learner@example.com", "ghost@example.com"] },
  });
  assert.deepEqual(r.body, {
    enrolled: ["learner@example.com"],
    alreadyEnrolled: [],
    notFound: ["ghost@example.com"],
  });
  assert.equal(
    (
      await author(`/api/admin/courses/${id}/enrolments`, {
        method: "POST",
        body: { emails: ["learner@example.com"] },
      })
    ).body.alreadyEnrolled.length,
    1,
  );
  assert.equal((await learner("/api/courses")).body.length, 1);
  assert.equal((await learner(`/api/courses/${id}`)).status, 200);
  const list = (await author(`/api/admin/courses/${id}/enrolments`)).body;
  assert.deepEqual(
    list.map(e => [e.email, e.self_enrolled]),
    [["learner@example.com", false]],
  );
  const lid = list[0].id;
  assert.equal(
    (await author(`/api/admin/courses/${id}/enrolments/${lid}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal((await learner(`/api/courses/${id}`)).status, 404);
  assert.equal(
    (await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } })).status,
    404,
  );
  s.close();
});

test("open enrolment: learners can self-enrol and it is recorded as such; staff can preview without enrolling", async () => {
  const s = await start();
  const { author, id } = await publishedCourse(s);
  const learner = await s.as("learner");
  assert.equal(
    (await author(`/api/admin/courses/${id}`, { method: "PATCH", body: { enrolment: "sometimes" } })).status,
    400,
  );
  await author(`/api/admin/courses/${id}`, {
    method: "PATCH",
    body: { enrolment: "open", title: "Renamed" },
  });
  assert.deepEqual(
    (await learner("/api/courses/available")).body.map(c => c.title),
    ["Renamed"],
  );
  assert.equal((await learner(`/api/courses/${id}/enrol`, { method: "POST", body: {} })).status, 201);
  assert.deepEqual((await learner("/api/courses/available")).body, []);
  assert.equal((await learner("/api/courses")).body.length, 1);
  assert.equal((await author(`/api/admin/courses/${id}/enrolments`)).body[0].self_enrolled, true);
  assert.equal((await author(`/api/courses/${id}`)).status, 200); // staff preview
  assert.equal(
    (await author(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } })).status,
    403,
  ); // but not take the quiz
  s.close();
});

test("authoring: build a course from scratch with lessons and questions, then publish it", async () => {
  const s = await start();
  const author = await s.as("author"),
    learner = await s.as("learner");
  assert.equal((await learner("/api/admin/courses", { method: "POST", body: { title: "No" } })).status, 403);
  assert.equal((await author("/api/admin/courses", { method: "POST", body: { title: "  " } })).status, 400);
  const {
    body: { id },
  } = await author("/api/admin/courses", {
    method: "POST",
    body: { title: "<b>Handling complaints</b>", description: "How we respond" },
  });
  assert.equal((await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} })).status, 400); // no lessons yet

  const l1 = await author(`/api/admin/courses/${id}/lessons`, {
    method: "POST",
    body: { title: "Listen first", body: "<p>Hi</p><script>alert(1)</script>" },
  });
  assert.equal(l1.status, 201);
  assert.ok(!l1.body.body.includes("script")); // sanitised
  assert.equal(
    (
      await author(`/api/admin/courses/${id}/lessons`, {
        method: "POST",
        body: { title: "", body: "<p>x</p>" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await author(`/api/admin/courses/${id}/lessons`, {
        method: "POST",
        body: { title: "Empty", body: "<script>x</script>" },
      })
    ).status,
    400,
  );
  const l2 = await author(`/api/admin/courses/${id}/lessons`, {
    method: "POST",
    body: { title: "Then respond", body: "<p>Reply</p>" },
  });
  assert.deepEqual([l1.body.position, l2.body.position], [0, 1]);

  const q = await author(`/api/admin/courses/${id}/questions`, {
    method: "POST",
    body: { prompt: "First step?", options: ["Listen", "Argue"], answer: 0, explanation: "Hear them out." },
  });
  assert.equal(q.status, 201);
  assert.deepEqual([q.body.source, q.body.status], ["manual", "approved"]);
  assert.equal(
    (
      await author(`/api/admin/courses/${id}/questions`, {
        method: "POST",
        body: { prompt: "Bad", options: ["a", "b"], answer: 7 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await author(`/api/admin/courses/${id}/questions`, {
        method: "POST",
        body: { prompt: "Bad", options: ["a", "a"], answer: 0 },
      })
    ).status,
    400,
  );

  assert.equal((await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} })).status, 200);
  const full = (await author(`/api/admin/courses/${id}`)).body;
  assert.deepEqual([full.title, full.lessons.length, full.questions.length], ["Handling complaints", 2, 1]);
  s.close();
});

test("authoring: edit lessons, reorder lessons and questions (exact set only), delete closes position gaps", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  addLessons(s, id, 2);
  const lessons = (await author(`/api/admin/courses/${id}`)).body.lessons;
  const [a, b, c] = lessons.map(l => l.id);
  const edited = await author(`/api/admin/lessons/${a}`, { method: "PATCH", body: { title: "Renamed" } });
  assert.deepEqual([edited.status, edited.body.title, edited.body.body.length > 0], [200, "Renamed", true]); // body kept when not sent
  assert.equal(
    (await author(`/api/admin/lessons/${a}`, { method: "PATCH", body: { title: "" } })).status,
    400,
  );

  for (const order of [[a, b], [a, b, b], [a, b, 9999], "nope"])
    assert.equal(
      (await author(`/api/admin/courses/${id}/lessons/order`, { method: "PUT", body: { order } })).status,
      400,
      JSON.stringify(order),
    );
  assert.equal(
    (await author(`/api/admin/courses/${id}/lessons/order`, { method: "PUT", body: { order: [c, a, b] } }))
      .status,
    200,
  );
  assert.deepEqual(
    (await author(`/api/admin/courses/${id}`)).body.lessons.map(l => l.id),
    [c, a, b],
  );

  assert.equal((await author(`/api/admin/lessons/${a}`, { method: "DELETE" })).status, 204);
  assert.deepEqual(
    (await author(`/api/admin/courses/${id}`)).body.lessons.map(l => [l.id, l.position]),
    [
      [c, 0],
      [b, 1],
    ],
  );

  const qs = (await author(`/api/admin/courses/${id}`)).body.questions.map(q => q.id);
  assert.equal(
    (
      await author(`/api/admin/courses/${id}/questions/order`, {
        method: "PUT",
        body: { order: [...qs].reverse() },
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (await author(`/api/admin/courses/${id}`)).body.questions.map(q => q.id),
    [...qs].reverse(),
  );
  s.close();
});

test("authoring: a published course keeps at least one lesson; deleting a lesson re-checks completion and drops ticks, not completions", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  addLessons(s, id, 1); // two lessons
  const learner = await s.as("learner");
  const [l1, l2] = await lessonIds(learner, id);
  await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} });
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, false); // lesson 2 outstanding

  await author(`/api/admin/lessons/${l2}`, { method: "DELETE" }); // the only thing missing is gone
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, true);
  assert.equal((await author(`/api/admin/lessons/${l1}`, { method: "DELETE" })).status, 409); // last lesson of a published course
  s.close();
});

test("authoring: changing questions re-checks completion; editing a question never rewrites an old attempt", async () => {
  const s = await start();
  const { author, id, qids, answers } = await quizCourse(s, { completion: "both" });
  const learner = await s.as("learner");
  const [l1] = await lessonIds(learner, id);
  await learner(`/api/courses/${id}/lessons/${l1}/complete`, { method: "POST", body: {} });
  const attempt = await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(1) } }); // fails
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, false);
  await author(`/api/admin/questions/${qids[0]}`, {
    method: "PATCH",
    body: { prompt: "Completely different question?" },
  });
  const old = (await learner(`/api/attempts/${attempt.body.id}`)).body;
  assert.match(old.results[0].prompt, /Placeholder/); // snapshot, not the edited text

  for (const qid of qids) await author(`/api/admin/questions/${qid}`, { method: "DELETE" }); // no quiz left, lessons done
  assert.equal((await learner(`/api/courses/${id}/progress`)).body.completed, true);
  s.close();
});

test("authoring: only drafts can be deleted; unpublish hides the course but keeps enrolments and attempts", async () => {
  const s = await start();
  const { author, id, answers } = await quizCourse(s);
  const learner = await s.as("learner");
  await learner(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: answers(0) } });
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "DELETE" })).status, 409); // published
  await author(`/api/admin/courses/${id}/unpublish`, { method: "POST", body: {} });
  assert.equal((await learner(`/api/courses/${id}`)).status, 404);
  assert.equal((await author(`/api/admin/courses/${id}/enrolments`)).body.length, 1); // kept
  await author(`/api/admin/courses/${id}/publish`, { method: "POST", body: {} });
  assert.equal((await learner(`/api/courses/${id}/attempts`)).body.attemptsUsed, 1); // kept
  await author(`/api/admin/courses/${id}/unpublish`, { method: "POST", body: {} });
  assert.equal((await author(`/api/admin/courses/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await author(`/api/admin/courses/${id}`)).status, 404);
  s.close();
});
