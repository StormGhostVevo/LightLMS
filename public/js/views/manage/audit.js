import { api } from "../../api.js";
import { h, notice, when, put, add, btn, guarded } from "../../dom.js";

// What each recorded action means, in words. Anything not listed is shown as it was recorded.
const WORDS = {
  "user.created": "Created a user",
  "user.role_changed": "Changed a role",
  "user.deactivated": "Deactivated a user",
  "user.reactivated": "Reactivated a user",
  "user.password_reset": "Reset a password",
  "user.password_changed": "Changed their own password",
  "user.data_exported": "Exported a person's data",
  "user.erased": "Erased a person",
  "course.created": "Created a course",
  "course.settings_changed": "Changed course settings",
  "course.published": "Published a course",
  "course.unpublished": "Unpublished a course",
  "course.deleted": "Deleted a course",
  "enrolment.added": "Enrolled people",
  "enrolment.removed": "Removed someone from a course",
  "certificate.revoked": "Revoked a certificate",
  "certificate.restored": "Restored a certificate",
  "certificate.name_changed": "Corrected a name on a certificate",
  "backup.created": "Made a backup",
  "backup.downloaded": "Downloaded a backup",
  "theme.changed": "Changed the appearance",
  "theme.reset": "Reset the appearance",
  "ai.course_drafted": "Drafted a course with AI",
  "ai.quiz_generated": "Generated quiz questions with AI",
};

// "pass_mark: 70 to 80" for a change, "role: author" for a plain value.
const describe = detail =>
  Object.entries(detail)
    .map(([k, v]) =>
      v && typeof v === "object" && "from" in v && "to" in v
        ? `${k.replaceAll("_", " ")}: ${v.from ?? "none"} to ${v.to ?? "none"}`
        : `${k.replaceAll("_", " ")}: ${Array.isArray(v) ? v.join(", ") : v}`,
    )
    .join("; ");

export async function auditView(main, { user }) {
  if (user.role !== "admin") {
    return void put(main, h("h1", null, "Audit log"), notice("Only administrators can read the audit log."));
  }
  const msg = h("div");
  const body = h("tbody");
  const more = h("p");
  const filter = h(
    "select",
    { "aria-label": "Show" },
    h("option", { value: "" }, "Everything"),
    Object.entries(WORDS).map(([k, label]) => h("option", { value: k }, label)),
  );
  let next = null;

  async function load(reset) {
    if (reset) {
      put(body);
      next = null;
    }
    const q = new URLSearchParams({ limit: "50" });
    if (filter.value) q.set("action", filter.value);
    if (next) q.set("before", String(next));
    const page = await api(`/admin/audit?${q}`);
    add(
      body,
      page.entries.map(e =>
        h(
          "tr",
          null,
          h("td", null, when(e.at)),
          h("td", null, e.actor || "System"),
          h("th", { scope: "row" }, WORDS[e.action] || e.action),
          h("td", null, e.target.label || ""),
          h("td", null, describe(e.detail)),
        ),
      ),
    );
    next = page.next;
    put(more, next ? btn("Show older", e => guarded(e.target, msg, () => load(false))) : null);
    if (reset && !page.entries.length) put(more, h("span", { class: "hint" }, "Nothing recorded yet."));
  }
  filter.addEventListener("change", () => guarded(null, msg, () => load(true)));

  put(
    main,
    h("p", null, h("a", { href: "#/manage" }, "All courses")),
    h("h1", null, "Audit log"),
    h(
      "p",
      { class: "hint" },
      "A record of important changes: who made them and when. Passwords and personal answers are never recorded.",
    ),
    msg,
    h("p", { class: "row" }, h("label", { for: (filter.id = "audit-filter") }, "Show"), filter),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        null,
        h("caption", { class: "sr" }, "Audit log, newest first"),
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["When", "Who", "What", "About", "Details"].map(t => h("th", { scope: "col" }, t)),
          ),
        ),
        body,
      ),
    ),
    more,
  );
  await load(true);
}
