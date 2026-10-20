import { api } from "../../api.js";
import { h, notice, field, btn, guarded, uid } from "../../dom.js";

export function questionsTab(body, { id, course, reload }) {
  const msg = h("div");
  const qs = course.questions;
  const drafts = qs.filter(q => q.status === "draft");

  const move = async (i, dir) => {
    const order = qs.map(q => q.id);
    [order[i], order[i + dir]] = [order[i + dir], order[i]];
    if (await guarded(null, msg, () => api(`/admin/courses/${id}/questions/order`, { method: "PUT", body: { order } }))) await reload();
  };
  const setStatus = (q, status) => guarded(null, msg, () => api(`/admin/questions/${q.id}`, { method: "PATCH", body: { status } })).then(ok => ok && reload());

  // One form for adding and editing: a prompt, 2 to 6 options with one marked correct, and an explanation.
  function form(q, host) {
    const err = h("div");
    const group = `correct-${uid()}`;
    const prompt = h("textarea", { rows: 2, maxlength: 500 }, q?.prompt || "");
    const explanation = h("textarea", { rows: 2, maxlength: 500 }, q?.explanation || "");
    const rows = h("div");
    const addOption = (text = "", correct = false) => {
      const input = h("input", { type: "text", maxlength: 300, value: text, "aria-label": "Answer option" });
      const radio = h("input", { type: "radio", name: group, "aria-label": "This is the correct answer", checked: correct });
      const row = h("div", { class: "option-row" }, radio, input, btn("Remove", () => { if (rows.children.length > 2) row.remove(); }, "secondary small", { "aria-label": "Remove this option" }));
      rows.append(row);
    };
    (q ? q.options : ["", ""]).forEach((o, i) => addOption(o, q ? i === q.answer : i === 0));
    const save = h("button", { type: "submit" }, q ? "Save question" : "Add question");
    host.replaceChildren(h("form", { class: "card", novalidate: true, onsubmit: async e => {
        e.preventDefault();
        const options = [...rows.querySelectorAll(".option-row")].map(r => ({ text: r.querySelector("input[type=text]").value.trim(), correct: r.querySelector("input[type=radio]").checked }));
        const kept = options.filter(o => o.text);
        const answer = kept.findIndex(o => o.correct);
        if (!prompt.value.trim()) return void err.replaceChildren(notice("Write the question."));
        if (kept.length < 2) return void err.replaceChildren(notice("Give at least two answer options."));
        if (new Set(kept.map(o => o.text)).size !== kept.length) return void err.replaceChildren(notice("Each answer option must be different."));
        if (answer < 0) return void err.replaceChildren(notice("Select which option is correct."));
        const payload = { prompt: prompt.value, options: kept.map(o => o.text), answer, explanation: explanation.value };
        const ok = await guarded(save, err, () => q ? api(`/admin/questions/${q.id}`, { method: "PATCH", body: payload })
                                                    : api(`/admin/courses/${id}/questions`, { method: "POST", body: payload }));
        if (ok) await reload();
      } },
      h("h3", null, q ? "Edit question" : "New question"), err,
      field("Question", prompt),
      h("fieldset", { class: "plain" }, h("legend", null, "Answer options (select the correct one)"), rows,
        rows.children.length < 6 ? btn("Add an option", () => { if (rows.children.length < 6) addOption(); }) : null),
      field("Explanation (shown after answering, if the course allows)", explanation),
      h("p", null, save, " ", btn("Cancel", () => host.replaceChildren()))));
    prompt.focus();
  }

  // AI: more draft questions from the lessons.
  const aiMsg = h("div");
  const count = h("select", { "aria-label": "How many questions" }, [3, 5, 8, 10].map(n => h("option", { value: n, selected: n === 5 }, `${n} questions`)));
  const gen = h("button", { type: "button", onclick: async e => {
      const r = await guarded(e.target, aiMsg, () => { aiMsg.replaceChildren(notice("Writing questions. This can take up to a minute.", "ok")); return api(`/admin/courses/${id}/quiz/generate`, { method: "POST", body: { count: Number(count.value) } }); });
      if (r) { await reload(); if (r.flags?.length) document.querySelector("main").prepend(h("div", { class: "notice warn", role: "status" }, `Added ${r.added} draft questions. `, r.flags.join(" "))); }
    } }, "Generate with AI");

  const addHost = h("div");
  body.append(
    h("h2", null, "Questions"),
    h("p", { class: "hint" }, "Learners only see approved questions. Questions written by the AI start as drafts: read each one, fix it if needed, then approve it."),
    msg,
    h("div", { class: "row" }, btn("Add a question", () => form(null, addHost), ""), gen, count,
      drafts.length ? btn(`Approve all ${drafts.length} drafts`, async e => {
        if (!confirm(`Approve all ${drafts.length} draft questions? Make sure you've read them.`)) return;
        e.target.disabled = true;
        try { for (const q of drafts) await api(`/admin/questions/${q.id}`, { method: "PATCH", body: { status: "approved" } }); await reload(); }
        catch (err) { msg.replaceChildren(notice(err.message)); e.target.disabled = false; }
      }) : null),
    aiMsg, addHost,
    qs.length ? h("ol", { class: "manage-list" }, qs.map((q, i) => {
      const host = h("div");
      return h("li", null,
        h("div", { class: "row between" },
          h("span", null, h("span", { class: `badge ${q.status}` }, q.status === "approved" ? "Approved" : "Draft"), " ", q.source === "ai" ? h("span", { class: "badge muted" }, "AI") : null),
          h("span", { class: "row" },
            btn("Up", () => move(i, -1), "secondary small", { disabled: i === 0, "aria-label": `Move question ${i + 1} up` }),
            btn("Down", () => move(i, 1), "secondary small", { disabled: i === qs.length - 1, "aria-label": `Move question ${i + 1} down` }),
            btn(q.status === "approved" ? "Unapprove" : "Approve", () => setStatus(q, q.status === "approved" ? "draft" : "approved"), "secondary small", { "aria-label": `${q.status === "approved" ? "Unapprove" : "Approve"} question ${i + 1}` }),
            btn("Edit", () => form(q, host), "secondary small", { "aria-label": `Edit question ${i + 1}` }),
            btn("Delete", async e => {
              if (!confirm("Delete this question?")) return;
              if (await guarded(e.target, msg, () => api(`/admin/questions/${q.id}`, { method: "DELETE" }))) await reload();
            }, "danger small", { "aria-label": `Delete question ${i + 1}` }))),
        h("p", { class: "q" }, q.prompt),
        h("ul", { class: "options" }, q.options.map((o, k) => h("li", { class: k === q.answer ? "correct" : "" }, o, k === q.answer ? " (correct)" : ""))),
        q.explanation ? h("p", { class: "hint" }, q.explanation) : null,
        host);
    })) : h("p", { class: "hint" }, "No questions yet."));
}
