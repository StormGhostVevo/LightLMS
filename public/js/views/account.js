import { api } from "../api.js";
import { h, notice, when, put, add } from "../dom.js";

// Used for the forced change after a temporary password, and from the Account page.
/** @param {{ forced?: boolean, onDone?: () => void }} options */
export function passwordView({ forced = false, onDone } = {}) {
  const msg = h("div");
  const current = h("input", {
    id: "cur",
    type: "password",
    autocomplete: "current-password",
    required: true,
  });
  const next = h("input", {
    id: "new",
    type: "password",
    autocomplete: "new-password",
    required: true,
    minlength: 10,
  });
  const again = h("input", { id: "again", type: "password", autocomplete: "new-password", required: true });
  const submit = h("button", { type: "submit" }, "Change password");
  return h(
    "form",
    {
      class: "card",
      novalidate: true,
      onsubmit: async e => {
        e.preventDefault();
        put(msg);
        if (next.value.length < 10)
          return void add(msg, notice("The new password needs at least 10 characters."));
        if (next.value !== again.value) return void add(msg, notice("The two new passwords don't match."));
        submit.disabled = true;
        try {
          await api("/auth/password", { method: "POST", body: { current: current.value, next: next.value } });
          current.value = next.value = again.value = "";
          if (onDone) onDone();
          else add(msg, notice("Password changed. Any other devices were signed out.", "ok"));
        } catch (err) {
          add(msg, notice(err.message));
        } finally {
          submit.disabled = false;
        }
      },
    },
    h(forced ? "h1" : "h2", null, forced ? "Choose your own password" : "Change password"),
    forced ? h("p", null, "You're using a temporary password. Choose a new one to continue.") : null,
    msg,
    h("label", { for: "cur" }, forced ? "Temporary password" : "Current password"),
    current,
    h("label", { for: "new" }, "New password (at least 10 characters)"),
    next,
    h("label", { for: "again" }, "New password again"),
    again,
    submit,
  );
}

export async function accountView(main, { user, setUser }) {
  const certs = await api("/certificates");
  const nameMsg = h("div");
  const name = h("input", {
    id: "name",
    type: "text",
    autocomplete: "name",
    value: user.name || "",
    maxlength: 200,
  });
  put(
    main,
    h("h1", null, "Account"),
    h(
      "section",
      { class: "card" },
      h("h2", null, "Your details"),
      h("p", null, `Signed in as ${user.email}.`),
      nameMsg,
      h(
        "form",
        {
          novalidate: true,
          onsubmit: async e => {
            e.preventDefault();
            put(nameMsg);
            try {
              setUser(await api("/auth/me", { method: "PATCH", body: { name: name.value } }));
              add(nameMsg, notice("Saved.", "ok"));
            } catch (err) {
              add(nameMsg, notice(err.message));
            }
          },
        },
        h("label", { for: "name" }, "Your name"),
        name,
        h(
          "p",
          { class: "hint" },
          "This is the name printed on certificates you earn from now on. Existing certificates keep the name they were issued with.",
        ),
        h("button", { type: "submit" }, "Save name"),
      ),
    ),
    h(
      "section",
      null,
      h("h2", null, "Certificates"),
      certs.length
        ? h(
            "ul",
            { class: "list" },
            certs.map(c =>
              h(
                "li",
                null,
                h("a", { href: c.url, target: "_blank", rel: "noopener" }, c.courseTitle),
                ` issued ${when(c.issuedAt)}`,
                c.revoked ? " (revoked)" : "",
              ),
            ),
          )
        : h("p", { class: "hint" }, "You haven't earned a certificate yet."),
    ),
    passwordView({}),
  );
}
