import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanBody } from "../ai.js";
import { tidyQuestions, cleanQuestion, mark } from "../question-types/index.js";
import { plain } from "../text.js";
import { rowFor } from "./helpers.js";

test("text: plain keeps real characters, so 'R&D' matches what a learner types", () => {
  assert.equal(plain('R&D <b>team</b> & "quotes" it\'s'), `R&D team & "quotes" it's`);
  assert.equal(plain("<script>alert(1)</script>safe"), "safe");
  assert.equal(
    cleanQuestion({ type: "short_answer", prompt: "Dept?", accepted: ["R&D"] }).value.spec.accepted[0],
    "R&D",
  );
  assert.equal(
    mark(rowFor({ type: "short_answer", prompt: "Dept?", accepted: ["R&D"] }), "r&d").correct,
    true,
  );
});

test("tidyQuestions drops bad questions; cleanBody strips scripts", () => {
  const flags = [];
  const out = tidyQuestions(
    [
      { prompt: "Ok?", options: ["a", "b"], answer: 1, explanation: "" },
      { prompt: "Bad index", options: ["a", "b"], answer: 5, explanation: "" },
      { prompt: "Dupes", options: ["a", "a"], answer: 0, explanation: "" },
    ],
    flags,
  );
  assert.equal(out.length, 1);
  assert.equal(flags.length, 2);
  assert.ok(!cleanBody('<p>hi</p><script>alert(1)</script><a href="javascript:x">l</a>').includes("script"));
});
