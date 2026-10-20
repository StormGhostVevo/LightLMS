import { api } from "../../api.js";
import { h, notice, field, btn, guarded, uid, put, add } from "../../dom.js";

const TYPE_LABELS = {
  mcq: "Multiple choice",
  true_false: "True or false",
  multiple_response: "Select all that apply",
  short_answer: "Short answer",
  numeric: "Number",
  matching: "Matching",
};
const TYPE_HINTS = {
  mcq: "One correct option.",
  true_false: "A statement that is either true or false.",
  multiple_response: "More than one option can be correct, and the learner must pick exactly the right ones.",
  short_answer: "The learner types a word or short phrase. Capital letters and extra spaces are ignored.",
  numeric: "The learner types a number. Set a tolerance if close answers should count.",
  matching: "The learner matches each item with its pair.",
};

// What a question's answer looks like in the list, so an author can check it at a glance.
function answerKey(q) {
  switch (q.type) {
    case "mcq":
    case "true_false":
      return h(
        "ul",
        { class: "options" },
        q.options.map((o, k) =>
          h("li", { class: k === q.answer ? "correct" : "" }, o, k === q.answer ? " (correct)" : ""),
        ),
      );
    case "multiple_response":
      return h(
        "ul",
        { class: "options" },
        q.options.map((o, k) =>
          h(
            "li",
            { class: q.answers.includes(k) ? "correct" : "" },
            o,
            q.answers.includes(k) ? " (correct)" : "",
          ),
        ),
      );
    case "short_answer":
      return h("p", { class: "options correct" }, `Accepted: ${q.accepted.join(" or ")}`);
    case "numeric":
      return h(
        "p",
        { class: "options correct" },
        q.tolerance > 0 ? `Answer: ${q.value}, give or take ${q.tolerance}` : `Answer: ${q.value}`,
      );
    default:
      return h(
        "ul",
        { class: "options" },
        q.pairs.map(p => h("li", { class: "correct" }, `${p.left} → ${p.right}`)),
      );
  }
}

// The part of the form that changes with the question type. `read()` returns just that type's fields.
function typeFields(type, q) {
  if (type === "mcq" || type === "multiple_response") {
    const multi = type === "multiple_response",
      group = `correct-${uid()}`,
      rows = h("div");
    const sameKind = q && q.type === type;
    const isCorrect = k =>
      !sameKind ? (multi ? false : k === 0) : multi ? q.answers.includes(k) : k === q.answer;
    const addOption = (text = "", correct = false) => {
      const mark = h("input", {
        type: multi ? "checkbox" : "radio",
        name: group,
        "aria-label": multi ? "This option is correct" : "This is the correct answer",
        checked: correct,
      });
      const input = h("input", { type: "text", maxlength: 300, value: text, "aria-label": "Answer option" });
      const row = h(
        "div",
        { class: "option-row" },
        mark,
        input,
        btn(
          "Remove",
          () => {
            if (rows.children.length > 2) row.remove();
          },
          "secondary small",
          { "aria-label": "Remove this option" },
        ),
      );
      add(rows, row);
    };
    (sameKind || q?.options?.length ? q.options : ["", ""]).forEach((o, i) => addOption(o, isCorrect(i)));
    if (!rows.children.length) {
      addOption("", !multi);
      addOption();
    }
    return {
      el: h(
        "fieldset",
        { class: "plain" },
        h(
          "legend",
          null,
          multi ? "Answer options (tick every correct one)" : "Answer options (select the correct one)",
        ),
        rows,
        btn("Add an option", () => {
          if (rows.children.length < 6) addOption();
        }),
      ),
      read: () => {
        const all = [...rows.querySelectorAll(".option-row")].map(r => ({
          text: r.querySelector("input[type=text]").value.trim(),
          on: r.querySelector("input:not([type=text])").checked,
        }));
        const kept = all.filter(o => o.text);
        return multi
          ? { options: kept.map(o => o.text), answers: kept.flatMap((o, k) => (o.on ? [k] : [])) }
          : { options: kept.map(o => o.text), answer: kept.findIndex(o => o.on) };
      },
    };
  }
  if (type === "true_false") {
    const group = `tf-${uid()}`;
    const t = h("input", {
        type: "radio",
        name: group,
        checked: q?.type === "true_false" ? q.answer === 0 : true,
      }),
      f = h("input", { type: "radio", name: group, checked: q?.type === "true_false" && q.answer === 1 });
    return {
      el: h(
        "fieldset",
        { class: "plain" },
        h("legend", null, "The statement is"),
        h("label", { class: "choice" }, t, h("span", null, "True")),
        h("label", { class: "choice" }, f, h("span", null, "False")),
      ),
      read: () => ({ answer: t.checked ? 0 : 1 }),
    };
  }
  if (type === "short_answer") {
    const box = h(
      "textarea",
      { rows: 3, maxlength: 1000 },
      q?.type === "short_answer" ? q.accepted.join("\n") : "",
    );
    return {
      el: field(
        "Accepted answers (one per line)",
        box,
        "Any of these counts as correct. Add spelling variations or alternative wording.",
      ),
      read: () => ({
        accepted: box.value
          .split("\n")
          .map(s => s.trim())
          .filter(Boolean),
      }),
    };
  }
  if (type === "numeric") {
    const value = h("input", {
      type: "text",
      inputmode: "decimal",
      value: q?.type === "numeric" ? q.value : "",
    });
    const tol = h("input", {
      type: "text",
      inputmode: "decimal",
      value: q?.type === "numeric" ? q.tolerance : 0,
    });
    return {
      el: h(
        "div",
        null,
        field("Correct number", value),
        field(
          "Tolerance (how far off still counts)",
          tol,
          "Use 0 for an exact answer. 0.5 accepts anything within 0.5 either side.",
        ),
      ),
      read: () => ({ value: value.value.trim(), tolerance: tol.value.trim() }),
    };
  }
  // matching
  const rows = h("div");
  const addPair = (left = "", right = "") => {
    const row = h(
      "div",
      { class: "pair-row" },
      h("input", { type: "text", maxlength: 200, value: left, "aria-label": "Item" }),
      h("span", { class: "arrow", "aria-hidden": "true" }, "→"),
      h("input", { type: "text", maxlength: 200, value: right, "aria-label": "Its match" }),
      btn(
        "Remove",
        () => {
          if (rows.children.length > 2) row.remove();
        },
        "secondary small",
        { "aria-label": "Remove this pair" },
      ),
    );
    add(rows, row);
  };
  (q?.type === "matching"
    ? q.pairs
    : [
        { left: "", right: "" },
        { left: "", right: "" },
        { left: "", right: "" },
      ]
  ).forEach(p => addPair(p.left, p.right));
  return {
    el: h(
      "fieldset",
      { class: "plain" },
      h("legend", null, "Pairs (an item and the match it belongs with)"),
      rows,
      btn("Add a pair", () => {
        if (rows.children.length < 8) addPair();
      }),
      h("p", { class: "hint" }, "Learners see the items in this order and the matches shuffled."),
    ),
    read: () => ({
      pairs: [...rows.querySelectorAll(".pair-row")].map(r => {
        const [l, m] = r.querySelectorAll("input");
        return { left: l.value.trim(), right: m.value.trim() };
      }),
    }),
  };
}

export function questionsTab(body, { id, course, reload }) {
  const msg = h("div");
  const qs = course.questions;
  const drafts = qs.filter(q => q.status === "draft");

  const move = async (i, dir) => {
    const order = qs.map(q => q.id);
    [order[i], order[i + dir]] = [order[i + dir], order[i]];
    if (
      await guarded(null, msg, () =>
        api(`/admin/courses/${id}/questions/order`, { method: "PUT", body: { order } }),
      )
    )
      await reload();
  };
  const setStatus = (q, status) =>
    guarded(null, msg, () => api(`/admin/questions/${q.id}`, { method: "PATCH", body: { status } })).then(
      ok => ok && reload(),
    );

  // One form for adding and editing. The fields under the type selector change when the type does.
  function form(q, host) {
    const err = h("div");
    const type = h(
      "select",
      { id: uid() },
      Object.entries(TYPE_LABELS).map(([k, label]) =>
        h("option", { value: k, selected: k === (q?.type || "mcq") }, label),
      ),
    );
    const prompt = h("textarea", { rows: 2, maxlength: 500 }, q?.prompt || "");
    const explanation = h("textarea", { rows: 2, maxlength: 500 }, q?.explanation || "");
    const hint = h("p", { class: "hint" }),
      slot = h("div");
    let fields;
    const drawType = () => {
      fields = typeFields(type.value, q);
      put(slot, fields.el);
      put(hint, TYPE_HINTS[type.value]);
    };
    type.addEventListener("change", drawType);
    drawType();
    const save = h("button", { type: "submit" }, q ? "Save question" : "Add question");
    put(
      host,
      h(
        "form",
        {
          class: "card",
          novalidate: true,
          onsubmit: async e => {
            e.preventDefault();
            if (!prompt.value.trim()) return void put(err, notice("Write the question."));
            const payload = {
              type: type.value,
              prompt: prompt.value,
              explanation: explanation.value,
              ...fields.read(),
            };
            const ok = await guarded(save, err, () =>
              q
                ? api(`/admin/questions/${q.id}`, { method: "PATCH", body: payload })
                : api(`/admin/courses/${id}/questions`, { method: "POST", body: payload }),
            );
            if (ok) await reload();
          },
        },
        h("h3", null, q ? "Edit question" : "New question"),
        err,
        field("Question type", type),
        hint,
        field(type.value === "true_false" ? "Statement" : "Question", prompt),
        slot,
        field("Explanation (shown after answering, if the course allows)", explanation),
        h(
          "p",
          null,
          save,
          " ",
          btn("Cancel", () => put(host)),
        ),
      ),
    );
    prompt.focus();
  }

  // AI: more draft questions from the lessons.
  const aiMsg = h("div");
  const MIXES = [
    ["mcq", "Multiple choice only", ["mcq"]],
    ["mixed", "A mix of common types", ["mcq", "true_false", "multiple_response", "short_answer"]],
    ["all", "Every type", Object.keys(TYPE_LABELS)],
  ];
  const mix = h(
    "select",
    { "aria-label": "Question types" },
    MIXES.map(([v, label]) => h("option", { value: v, selected: v === "mixed" }, label)),
  );
  const count = h(
    "select",
    { "aria-label": "How many questions" },
    [3, 5, 8, 10].map(n => h("option", { value: n, selected: n === 5 }, `${n} questions`)),
  );
  const gen = h(
    "button",
    {
      type: "button",
      onclick: async e => {
        const types = MIXES.find(m => m[0] === mix.value)[2];
        const r = await guarded(e.target, aiMsg, () => {
          put(aiMsg, notice("Writing questions. This can take up to a minute.", "ok"));
          return api(`/admin/courses/${id}/quiz/generate`, {
            method: "POST",
            body: { count: Number(count.value), types },
          });
        });
        if (r) {
          await reload();
          if (r.flags?.length)
            document
              .querySelector("main")
              .prepend(
                h(
                  "div",
                  { class: "notice warn", role: "status" },
                  `Added ${r.added} draft questions. `,
                  r.flags.join(" "),
                ),
              );
        }
      },
    },
    "Generate with AI",
  );

  const addHost = h("div");
  add(
    body,
    h("h2", null, "Questions"),
    h(
      "p",
      { class: "hint" },
      "Learners only see approved questions. Questions written by the AI start as drafts: read each one, fix it if needed, then approve it.",
    ),
    msg,
    h(
      "div",
      { class: "row" },
      btn("Add a question", () => form(null, addHost), ""),
      gen,
      mix,
      count,
      drafts.length
        ? btn(`Approve all ${drafts.length} drafts`, async e => {
            if (!confirm(`Approve all ${drafts.length} draft questions? Make sure you've read them.`)) return;
            e.target.disabled = true;
            try {
              for (const q of drafts)
                await api(`/admin/questions/${q.id}`, { method: "PATCH", body: { status: "approved" } });
              await reload();
            } catch (err) {
              put(msg, notice(err.message));
              e.target.disabled = false;
            }
          })
        : null,
    ),
    aiMsg,
    addHost,
    qs.length
      ? h(
          "ol",
          { class: "manage-list" },
          qs.map((q, i) => {
            const host = h("div");
            return h(
              "li",
              null,
              h(
                "div",
                { class: "row between" },
                h(
                  "span",
                  null,
                  h("span", { class: `badge ${q.status}` }, q.status === "approved" ? "Approved" : "Draft"),
                  " ",
                  h("span", { class: "badge muted" }, TYPE_LABELS[q.type]),
                  " ",
                  q.source === "ai" ? h("span", { class: "badge muted" }, "AI") : null,
                ),
                h(
                  "span",
                  { class: "row" },
                  btn("Up", () => move(i, -1), "secondary small", {
                    disabled: i === 0,
                    "aria-label": `Move question ${i + 1} up`,
                  }),
                  btn("Down", () => move(i, 1), "secondary small", {
                    disabled: i === qs.length - 1,
                    "aria-label": `Move question ${i + 1} down`,
                  }),
                  btn(
                    q.status === "approved" ? "Unapprove" : "Approve",
                    () => setStatus(q, q.status === "approved" ? "draft" : "approved"),
                    "secondary small",
                    {
                      "aria-label": `${q.status === "approved" ? "Unapprove" : "Approve"} question ${i + 1}`,
                    },
                  ),
                  btn("Edit", () => form(q, host), "secondary small", {
                    "aria-label": `Edit question ${i + 1}`,
                  }),
                  btn(
                    "Delete",
                    async e => {
                      if (!confirm("Delete this question?")) return;
                      if (
                        await guarded(e.target, msg, () =>
                          api(`/admin/questions/${q.id}`, { method: "DELETE" }),
                        )
                      )
                        await reload();
                    },
                    "danger small",
                    { "aria-label": `Delete question ${i + 1}` },
                  ),
                ),
              ),
              h("p", { class: "q" }, q.prompt),
              answerKey(q),
              q.explanation ? h("p", { class: "hint" }, q.explanation) : null,
              host,
            );
          }),
        )
      : h("p", { class: "hint" }, "No questions yet."),
  );
}
