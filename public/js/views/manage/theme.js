import { api } from "../../api.js";
import { h, notice, field, btn, guarded } from "../../dom.js";

// ---- the same contrast maths as the server, so problems show while you pick colours ----
const channel = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = hex => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const LABELS = { background: "Page background", surface: "Cards and panels", text: "Text", link: "Links and outlines", button: "Buttons", buttonText: "Button text", header: "Top bar", headerText: "Top bar text" };
const GROUPS = [
  ["page", "Page colours", ["background", "surface", "text", "link"], "The page, cards, text and links."],
  ["buttons", "Button colours", ["button", "buttonText"], "Solid buttons such as Sign in or Submit."],
  ["header", "Top bar colours", ["header", "headerText"], "The bar with the navigation."],
];
const PAIRS = [["text", "background", "Text on the page background"], ["text", "surface", "Text on cards"], ["link", "background", "Links on the page background"],
  ["link", "surface", "Links on cards"], ["buttonText", "button", "Button text"], ["headerText", "header", "Top bar text"]];

// What the site looks like with nothing customised, for the device's current light or dark setting.
const BASE = {
  light: { background: "#f6f7f9", surface: "#ffffff", text: "#1d2330", link: "#2456d6", button: "#2456d6", buttonText: "#ffffff", header: "#ffffff", headerText: "#1d2330" },
  dark: { background: "#14171d", surface: "#1c212b", text: "#e8ebf1", link: "#6f9bff", button: "#6f9bff", buttonText: "#0b1020", header: "#1c212b", headerText: "#e8ebf1" },
};
const base = () => BASE[matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"];

const PRESETS = [
  ["Default", {}],
  ["Dark", { ...BASE.dark }],
  ["High contrast", { background: "#ffffff", surface: "#ffffff", text: "#000000", link: "#0033cc", button: "#000000", buttonText: "#ffffff", header: "#000000", headerText: "#ffffff" }],
  ["Warm", { background: "#faf6ef", surface: "#fffdf8", text: "#2b2118", link: "#9a3d12", button: "#b4501b", buttonText: "#ffffff", header: "#fffdf8", headerText: "#2b2118" }],
  ["Ocean", { background: "#eef6f9", surface: "#ffffff", text: "#10272f", link: "#0b6a88", button: "#0b6a88", buttonText: "#ffffff", header: "#0b3c4d", headerText: "#ffffff" }],
];

export async function themeView(main, { user, reloadTheme }) {
  if (user.role !== "admin") return void main.replaceChildren(h("h1", null, "Appearance"), notice("Only administrators can change the appearance."));
  const [theme, options] = await Promise.all([api("/theme"), api("/theme/options")]);

  const state = { colours: { ...theme.colours }, font: theme.font, fontSize: theme.fontSize, siteName: theme.siteName };
  const groupOn = keys => keys.every(k => state.colours[k]);
  const msg = h("div"), preview = h("div", { class: "preview" }), contrastBox = h("div");
  const inputs = {};                                   // key -> { colour, text } controls, kept in step with state

  const siteName = h("input", { type: "text", maxlength: 60, value: state.siteName });
  const font = h("select", null, options.fonts.map(f => h("option", { value: f.key, selected: f.key === state.font }, f.label)));
  const size = h("select", null, [["small", "Smaller"], ["normal", "Normal"], ["large", "Larger"]].map(([v, t]) => h("option", { value: v, selected: v === state.fontSize }, t)));
  const save = h("button", { type: "button" }, "Save appearance");

  const effective = () => ({ ...base(), ...state.colours });
  const problems = () => PAIRS.filter(([fg, bg]) => state.colours[fg] && state.colours[bg] && ratio(state.colours[fg], state.colours[bg]) < options.minContrast);

  function paint() {
    const c = effective(), stack = options.fonts.find(f => f.key === font.value).stack;
    for (const [k, v] of [["--bg", c.background], ["--surface", c.surface], ["--text", c.text], ["--link", c.link], ["--accent", c.button], ["--accent-text", c.buttonText],
                          ["--header", c.header], ["--header-text", c.headerText], ["--font", stack]]) preview.style.setProperty(k, v);
    preview.style.fontSize = { small: "93.75%", normal: "100%", large: "112.5%" }[size.value];
    const bad = problems();
    contrastBox.replaceChildren(h("ul", { class: "contrast-list" }, PAIRS.filter(([fg, bg]) => state.colours[fg] && state.colours[bg]).map(([fg, bg, label]) => {
      const r = ratio(state.colours[fg], state.colours[bg]);
      return h("li", { class: r < options.minContrast ? "low" : "" }, `${label}: ${r.toFixed(1)}:1 ${r < options.minContrast ? `(needs ${options.minContrast}:1 or more)` : "(good)"}`);
    })));
    save.disabled = bad.length > 0;
    save.title = bad.length ? "Fix the low-contrast colours first" : "";
  }

  function syncInputs() {
    for (const [key, { colour, text }] of Object.entries(inputs)) {
      const v = effective()[key];
      colour.value = v; text.value = v;
      colour.disabled = text.disabled = !state.colours[key];
    }
  }

  const groupEl = ([id, title, keys, hint]) => {
    const toggle = h("input", { type: "checkbox", id: `use-${id}`, checked: groupOn(keys) });
    toggle.addEventListener("change", () => {
      keys.forEach(k => { if (toggle.checked) state.colours[k] = base()[k]; else delete state.colours[k]; });
      syncInputs(); paint();
    });
    return h("fieldset", { class: "palette-group" }, h("legend", null, title),
      h("p", { class: "hint" }, hint),
      h("div", { class: "field check" }, toggle, h("label", { for: `use-${id}` }, "Use custom colours")),
      keys.map(k => {
        const colour = h("input", { type: "color", id: `c-${k}`, "aria-label": LABELS[k] });
        const text = h("input", { type: "text", maxlength: 7, "aria-label": `${LABELS[k]} as a hex code`, spellcheck: "false" });
        inputs[k] = { colour, text };
        colour.addEventListener("input", () => { state.colours[k] = colour.value; text.value = colour.value; paint(); });
        text.addEventListener("input", () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) { state.colours[k] = text.value.toLowerCase(); colour.value = text.value; paint(); } });
        return h("div", { class: "colour-row" }, h("label", { for: colour.id }, LABELS[k]), colour, text);
      }));
  };

  const applyPreset = colours => {
    state.colours = { ...colours };
    GROUPS.forEach(([id, , keys]) => { document.getElementById(`use-${id}`).checked = keys.every(k => state.colours[k]); });
    syncInputs(); paint();
  };

  font.addEventListener("change", paint); size.addEventListener("change", paint);
  save.addEventListener("click", async () => {
    const r = await guarded(save, msg, () => api("/admin/theme", { method: "PUT", body: { siteName: siteName.value, font: font.value, fontSize: size.value, colours: state.colours } }));
    if (r) { await reloadTheme(); msg.replaceChildren(notice("Saved. Everyone sees the new look straight away.", "ok")); }
  });

  main.replaceChildren(
    h("p", null, h("a", { href: "#/manage" }, "All courses")),
    h("h1", null, "Appearance"),
    h("p", { class: "hint" }, "Change the colours, font and name of the site. Each set of colours is chosen together, and the server refuses combinations that are hard to read."),
    msg,
    h("div", { class: "theme-layout" },
      h("div", null,
        h("section", { class: "card" }, h("h2", null, "Start from a preset"), h("div", { class: "presets" }, PRESETS.map(([name, colours]) => btn(name, () => applyPreset(colours))))),
        h("section", { class: "card" }, h("h2", null, "Name and text"),
          field("Site name", siteName, "Shown in the top bar and on the sign-in page. Leave blank to use lightlms."),
          field("Font", font, "Fonts already on people's devices, so nothing is downloaded from outside."),
          field("Text size", size)),
        GROUPS.map(groupEl),
        h("p", { class: "row" }, save, btn("Reset to default", async e => {
          if (!confirm("Reset the site to the default look?")) return;
          if (await guarded(e.target, msg, () => api("/admin/theme", { method: "DELETE" }))) { await reloadTheme(); location.reload(); }
        }, "secondary"))),
      h("aside", { class: "sticky", "aria-label": "Preview" },
        h("h2", null, "Preview"),
        preview, h("h3", null, "Readability"), contrastBox)));

  preview.append(
    h("div", { class: "p-bar" }, h("span", null, "Site name"), h("span", null, "My courses"), h("span", null, "Grades")),
    h("div", { class: "p-body" }, h("div", { class: "p-card" },
      h("h3", null, "Workplace safety basics"),
      h("p", null, "Some body text, with a ", h("a", { href: "#/manage/theme", onclick: e => e.preventDefault() }, "link"), " in it."),
      h("button", { type: "button", class: "p-btn" }, "Start the quiz"), h("button", { type: "button", class: "p-btn secondary" }, "Mark as done"))));
  syncInputs(); paint();
}
