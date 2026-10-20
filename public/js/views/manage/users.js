import { api } from "../../api.js";
import { h, notice, field, guarded, when, btn, put, th } from "../../dom.js";

export async function usersView(main, { user, flash, okMessage }) {
  if (user.role !== "admin")
    return void put(main, h("h1", null, "Manage users"), notice("Only administrators can manage users."));
  const users = await api("/admin/users");
  const msg = h("div");

  // A generated password is shown once, here, for the admin to pass on.
  const showPassword = (who, pw) =>
    put(
      msg,
      h(
        "div",
        { class: "notice warn", role: "status" },
        `Temporary password for ${who}: `,
        h("code", null, pw),
        h(
          "p",
          null,
          "This is shown once. Pass it on securely. They'll be asked to choose their own at first sign-in.",
        ),
      ),
    );

  const email = h("input", { type: "email", autocomplete: "off", required: true });
  const name = h("input", { type: "text", maxlength: 200 });
  const role = h(
    "select",
    null,
    [
      ["learner", "Learner"],
      ["author", "Author"],
      ["admin", "Admin"],
    ].map(([v, t]) => h("option", { value: v }, t)),
  );
  const create = h("button", { type: "submit" }, "Create user");

  // The page is rebuilt after a change, so anything to show afterwards travels with it.
  const redraw = (shown, ok) => usersView(main, { user, flash: shown, okMessage: ok });

  put(
    main,
    h("p", null, h("a", { href: "#/manage" }, "All courses")),
    h("h1", null, "Manage users"),
    msg,
    h(
      "form",
      {
        class: "card",
        novalidate: true,
        onsubmit: async e => {
          e.preventDefault();
          if (!email.value.trim()) return void put(msg, notice("Enter an email address."));
          const r = await guarded(create, msg, () =>
            api("/admin/users", {
              method: "POST",
              body: { email: email.value, name: name.value, role: role.value },
            }),
          );
          if (r) await redraw([r.email, r.temporaryPassword]); // the page is rebuilt, so the password travels with it
        },
      },
      h("h2", null, "New user"),
      field("Email", email),
      field("Name", name),
      field(
        "Role",
        role,
        "Learners take courses. Authors build and review courses. Admins can also manage users.",
      ),
      create,
    ),
    h("h2", null, "Everyone"),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        null,
        h("caption", { class: "sr" }, "All users"),
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["Email", "Name", "Role", "Status", "Last sign-in", ""].map(t => th(t)),
          ),
        ),
        h(
          "tbody",
          null,
          users.map(u => {
            const roleSel = h(
              "select",
              { "aria-label": `Role for ${u.email}` },
              ["learner", "author", "admin"].map(v =>
                h("option", { value: v, selected: v === u.role }, v[0].toUpperCase() + v.slice(1)),
              ),
            );
            roleSel.addEventListener("change", async () => {
              if (
                !(await guarded(roleSel, msg, () =>
                  api(`/admin/users/${u.id}`, { method: "PATCH", body: { role: roleSel.value } }),
                ))
              )
                roleSel.value = u.role;
              else put(msg, notice(`${u.email} is now ${roleSel.value}. They've been signed out.`, "ok"));
            });
            return h(
              "tr",
              null,
              h("th", { scope: "row" }, u.email),
              h("td", null, u.name),
              h("td", null, roleSel),
              h(
                "td",
                null,
                h(
                  "span",
                  { class: `badge ${u.active ? "published" : "draft"}` },
                  u.active ? "Active" : "Deactivated",
                ),
              ),
              h("td", null, u.last_login_at ? when(u.last_login_at) : "Never"),
              h(
                "td",
                null,
                h(
                  "span",
                  { class: "row" },
                  btn(
                    u.active ? "Deactivate" : "Reactivate",
                    async e => {
                      if (
                        u.active &&
                        !confirm(
                          `Deactivate ${u.email}? They're signed out and can't sign in until reactivated.`,
                        )
                      )
                        return;
                      if (
                        await guarded(e.target, msg, () =>
                          api(`/admin/users/${u.id}`, { method: "PATCH", body: { active: !u.active } }),
                        )
                      )
                        await redraw();
                    },
                    "secondary small",
                    { "aria-label": `${u.active ? "Deactivate" : "Reactivate"} ${u.email}` },
                  ),
                  h(
                    "a",
                    {
                      href: `/api/admin/users/${u.id}/export`,
                      download: "",
                      "aria-label": `Export data for ${u.email}`,
                    },
                    "Export data",
                  ),
                  btn(
                    "Erase",
                    async e => {
                      const typed = prompt(
                        `This removes ${u.email}'s account, answers and results for good. Certificates they earned stay valid without their name. Backups made earlier keep the old data until they are rotated out.\n\nType their email address to confirm.`,
                      );
                      if (typed === null) return;
                      const r = await guarded(e.target, msg, () =>
                        api(`/admin/users/${u.id}/erase`, { method: "POST", body: { confirm: typed } }),
                      );
                      if (r) await redraw(undefined, "That person has been erased.");
                    },
                    "danger small",
                    { "aria-label": `Erase ${u.email}` },
                  ),
                  btn(
                    "Reset password",
                    async e => {
                      if (!confirm(`Reset the password for ${u.email}? They're signed out everywhere.`))
                        return;
                      const r = await guarded(e.target, msg, () =>
                        api(`/admin/users/${u.id}`, { method: "PATCH", body: { resetPassword: true } }),
                      );
                      if (r) showPassword(u.email, r.temporaryPassword);
                    },
                    "secondary small",
                    { "aria-label": `Reset password for ${u.email}` },
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    ),
  );
  if (flash) showPassword(...flash);
  if (okMessage) put(msg, notice(okMessage, "ok"));
}
