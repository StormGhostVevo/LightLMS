import { api } from "./api.js";
import { h, clear } from "./dom.js";
import { loginView } from "./views/login.js";
import { passwordView, accountView } from "./views/account.js";
import { coursesView } from "./views/courses.js";
import { courseView } from "./views/course.js";
import { gradesView } from "./views/grades.js";

const root = document.getElementById("app");
let user = null;

const routes = [
  [/^#\/course\/(\d+)$/, courseView],
  [/^#\/grades$/, gradesView],
  [/^#\/account$/, accountView],
  [/^#\/?$/, coursesView],
];

function shell(main) {
  const link = (href, text) => h("a", { href, "aria-current": location.hash === href || (href === "#/" && !location.hash) ? "page" : null }, text);
  clear(root).append(
    h("header", { class: "bar" },
      h("a", { class: "brand", href: "#/" }, "lightlms"),
      h("nav", { "aria-label": "Main" }, link("#/", "My courses"), link("#/grades", "Grades"), link("#/account", "Account")),
      h("button", { class: "link", onclick: signOut }, "Sign out")),
    main);
  return main;
}

async function render() {
  if (!user) return showLogin();
  if (user.mustChangePassword) return showForcedPassword();
  const main = shell(h("main", { id: "main", tabindex: "-1" }, h("p", { class: "loading" }, "Loading")));
  const hash = location.hash || "#/";
  for (const [re, view] of routes) {
    const m = re.exec(hash);
    if (m) {
      try { await view(main, { user, params: m.slice(1), setUser: u => { user = u; } }); }
      catch (err) { clear(main).append(h("p", { class: "notice error", role: "alert" }, err.message)); }
      document.title = (main.querySelector("h1")?.textContent || "lightlms") + " | lightlms";
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = "#/";
}

function showLogin() {
  document.title = "Sign in | lightlms";
  clear(root).append(h("main", { id: "main", tabindex: "-1", class: "narrow" }, loginView(u => { user = u; location.hash = "#/"; render(); })));
}

function showForcedPassword() {
  document.title = "Choose a password | lightlms";
  clear(root).append(h("main", { id: "main", tabindex: "-1", class: "narrow" },
    passwordView({ forced: true, onDone: () => { user = { ...user, mustChangePassword: false }; render(); } })));
}

async function signOut() {
  try { await api("/auth/logout", { method: "POST" }); } catch { /* the session is gone either way */ }
  user = null; location.hash = "#/"; render();
}

document.addEventListener("signed-out", () => { user = null; render(); });
document.addEventListener("must-change-password", () => { if (user) { user.mustChangePassword = true; render(); } });
window.addEventListener("hashchange", render);

try { user = await api("/auth/me"); } catch { user = null; }
render();
