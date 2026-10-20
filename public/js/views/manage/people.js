import { api } from "../../api.js";
import { h, notice, field, guarded, when, btn, put, add } from "../../dom.js";

export async function peopleTab(body, { id, course }) {
  const people = await api(`/admin/courses/${id}/enrolments`);
  const msg = h("div"), report = h("div");
  const emails = h("textarea", { rows: 5, placeholder: "one email address per line" });
  const enrolBtn = h("button", { type: "submit" }, "Enrol");

  const refresh = async () => { put(body, ); await peopleTab(body, { id, course }); };

  add(body, 
    h("h2", null, "People"),
    course.enrolment === "open" ? h("p", { class: "hint" }, "This course is open: anyone signed in can also join themselves.") : null,
    h("form", { class: "card", novalidate: true, onsubmit: async e => {
        e.preventDefault();
        const list = emails.value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
        if (!list.length) return void put(msg, notice("Enter at least one email address."));
        if (list.length > 500) return void put(msg, notice("Enrol up to 500 people at a time."));
        const r = await guarded(enrolBtn, msg, () => api(`/admin/courses/${id}/enrolments`, { method: "POST", body: { emails: list } }));
        if (!r) return;
        await refresh();
        const note = h("div", { class: `notice ${r.notFound.length ? "warn" : "ok"}`, role: "status" },
          `Enrolled ${r.enrolled.length}. Already enrolled ${r.alreadyEnrolled.length}.`,
          r.notFound.length ? h("p", null, `No active account for: ${r.notFound.join(", ")}. Create them under Manage users first.`) : null);
        body.prepend(note);
      } },
      h("h3", null, "Enrol people"), msg, field("Email addresses", emails, "They need an account already."), enrolBtn),
    people.length
      ? h("div", { class: "table-wrap" }, h("table", null,
          h("caption", { class: "sr" }, "People enrolled in this course"),
          h("thead", null, h("tr", null, ["Email", "Name", "Enrolled", "How", ""].map(t => h("th", { scope: "col" }, t)))),
          h("tbody", null, people.map(p => h("tr", null,
            h("th", { scope: "row" }, p.email), h("td", null, p.name), h("td", null, when(p.enrolled_at)), h("td", null, p.self_enrolled ? "Joined themselves" : "Enrolled by staff"),
            h("td", null, btn("Remove", async e => {
              if (!confirm(`Remove ${p.email} from this course? They lose access. Their results are kept.`)) return;
              if (await guarded(e.target, msg, () => api(`/admin/courses/${id}/enrolments/${p.id}`, { method: "DELETE" }))) await refresh();
            }, "danger small", { "aria-label": `Remove ${p.email}` })))))))
      : h("p", { class: "hint" }, "Nobody is enrolled yet."));
}
