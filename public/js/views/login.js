import { api } from "../api.js";
import { h, notice } from "../dom.js";

export function loginView(onSignedIn) {
  const error = h("div");
  const email = h("input", { id: "email", type: "email", autocomplete: "username", required: true });
  const password = h("input", { id: "password", type: "password", autocomplete: "current-password", required: true });
  const submit = h("button", { type: "submit" }, "Sign in");
  return h("form", { class: "card", novalidate: true, onsubmit: async e => {
      e.preventDefault();
      error.replaceChildren();
      if (!email.value.trim() || !password.value) { error.append(notice("Enter your email and password.")); return; }
      submit.disabled = true;
      try { onSignedIn(await api("/auth/login", { method: "POST", body: { email: email.value.trim(), password: password.value } })); }
      catch (err) { error.append(notice(err.message)); password.value = ""; password.focus(); }
      finally { submit.disabled = false; }
    } },
    h("h1", null, "Sign in"),
    error,
    h("label", { for: "email" }, "Email"), email,
    h("label", { for: "password" }, "Password"), password,
    submit,
    h("p", { class: "hint" }, "There's no sign-up. Ask your administrator for an account."));
}
