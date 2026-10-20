import { api } from "../../api.js";
import { h, notice, when, field, guarded } from "../../dom.js";
import { handoff } from "../../state.js";

export async function manageView(main, { user }) {
  const [courses, ai] = await Promise.all([api("/admin/courses"), api("/admin/ai/status")]);
  const admin = user.role === "admin";

  // ---- new blank course ----
  const createMsg = h("div");
  const title = h("input", { type: "text", maxlength: 200, required: true });
  const createBtn = h("button", { type: "submit" }, "Create course");
  const create = h("form", { class: "card", novalidate: true, onsubmit: async e => {
      e.preventDefault();
      if (!title.value.trim()) return void createMsg.replaceChildren(notice("Give the course a title."));
      const made = await guarded(createBtn, createMsg, () => api("/admin/courses", { method: "POST", body: { title: title.value } }));
      if (made) location.hash = `#/manage/course/${made.id}/lessons`;
    } },
    h("h2", null, "New course"), createMsg, field("Title", title), createBtn);

  // ---- AI draft ----
  const aiMsg = h("div");
  const source = h("textarea", { rows: 8, maxlength: 60000, placeholder: "Paste the material the course should be built from." });
  const draftBtn = h("button", { type: "submit" }, "Draft with AI");
  const aiNote = ai.provider === "off" ? notice("AI isn't switched on for this site.", "error")
    : ai.sendsToThirdParty ? notice("The text you paste is sent to an external AI service (Anthropic). Only paste material you are cleared to share, and leave out client names, personal details and rates.", "warn")
    : notice("Demo mode: no AI is connected. Your text is split into lessons and the questions are placeholders.", "ok");
  const draft = h("form", { class: "card", novalidate: true, onsubmit: async e => {
      e.preventDefault();
      if (source.value.trim().length < 80) return void aiMsg.replaceChildren(notice("Paste a bit more text first (at least a couple of sentences)."));
      const made = await guarded(draftBtn, aiMsg, () => {
        aiMsg.replaceChildren(notice("Drafting. This can take up to a minute.", "ok"));
        return api("/admin/ai/draft-course", { method: "POST", body: { text: source.value } });
      });
      if (made) { handoff.flags = made.flags; location.hash = `#/manage/course/${made.id}/lessons`; }
    } },
    h("h2", null, "Draft a course with AI"),
    h("p", { class: "hint" }, "Creates a draft course with lessons and quiz questions. Nothing reaches learners until you review it and publish."),
    aiNote, aiMsg, field("Source material", source),
    ai.provider === "off" ? null : draftBtn);

  main.replaceChildren(
    h("h1", null, "Manage courses"),
    admin ? h("p", null, h("a", { href: "#/manage/users" }, "Manage users")) : null,
    h("div", { class: "grid2" }, create, draft),
    h("h2", null, "All courses"),
    courses.length
      ? h("div", { class: "table-wrap" }, h("table", null,
          h("caption", { class: "sr" }, "All courses"),
          h("thead", null, h("tr", null, ["Course", "Status", "Last changed"].map(t => h("th", { scope: "col" }, t)))),
          h("tbody", null, courses.map(c => h("tr", null,
            h("th", { scope: "row" }, h("a", { href: `#/manage/course/${c.id}` }, c.title)),
            h("td", null, h("span", { class: `badge ${c.status}` }, c.status === "published" ? "Published" : "Draft")),
            h("td", null, when(c.updated_at)))))))
      : h("p", { class: "hint" }, "No courses yet. Create one above."));
}
