import { api } from "./api.js";
import { h, clear } from "./dom.js";
import { loginView } from "./views/login.js";
import { passwordView, accountView } from "./views/account.js";
import { coursesView } from "./views/courses.js";
import { courseView } from "./views/course.js";
import { gradesView } from "./views/grades.js";
import { manageView } from "./views/manage/index.js";
import { manageCourseView } from "./views/manage/course.js";
import { usersView } from "./views/manage/users.js";
import { themeView } from "./views/manage/theme.js";

const root = document.getElementById("app");
let user = null;
let siteName = "";

// The look comes from /theme.css; this reloads it after an admin changes it, and picks up the site name.
async function reloadTheme() {
  try { siteName = (await api("/theme")).siteName; } catch { /* keep the old name */ }
  document.getElementById("theme-css").href = `/theme.css?v=${Date.now()}`;
  const brand = document.querySelector(".brand"); if (brand) brand.textContent = siteName || "lightlms";
}

const routes = [
  [/^#\/manage\/theme$/, themeView],
  [/^#\/manage\/users$/, usersView],
  [/^#\/manage\/course\/(\d+)(?:\/(\w+))?$/, manageCourseView],
  [/^#\/manage$/, manageView],
  [/^#\/course\/(\d+)$/, courseView],
  [/^#\/grades$/, gradesView],
  [/^#\/account$/, accountView],
  [/^#\/?$/, coursesView],
];

function shell(main) {
  const here = location.hash || "#/";
  const link = (href, text) => h("a", { href, "aria-current": here === href || (href === "#/manage" && here.startsWith("#/manage")) ? "page" : null }, text);
  clear(root).append(
    h("header", { class: "bar" },
      h("a", { class: "brand", href: "#/" }, siteName || "lightlms"),
      h("nav", { "aria-label": "Main" }, link("#/", "My courses"), link("#/grades", "Grades"), link("#/account", "Account"), user.role !== "learner" ? link("#/manage", "Manage") : null),
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
      try { await view(main, { user, params: m.slice(1), setUser: u => { user = u; }, reloadTheme }); }
      catch (err) { clear(main).append(h("p", { class: "notice error", role: "alert" }, err.message)); }
      document.title = (main.querySelector("h1")?.textContent || siteName || "lightlms") + " | " + (siteName || "lightlms");
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = "#/";
}

function showLogin() {
  document.title = "Sign in | lightlms";
  clear(root).append(h("main", { id: "main", tabindex: "-1", class: "narrow" }, loginView(u => { user = u; location.hash = "#/"; render(); }, siteName)));
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

await reloadTheme();
try { user = await api("/auth/me"); } catch { user = null; }
render();
