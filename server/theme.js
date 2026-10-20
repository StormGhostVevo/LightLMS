import { now, bad } from "./http.js";
import { target } from "./events.js";

// The site's look, set by an admin: colours (in groups, so a theme can't end up unreadable), a font and a text size.
// It is served as a stylesheet of CSS variables, so the pages themselves never change.

export const FONTS = {
  system: { label: "System default", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  friendly: {
    label: "Friendly sans (Trebuchet)",
    stack: '"Trebuchet MS", "Segoe UI", Candara, "Gill Sans", sans-serif',
  },
  serif: { label: "Classic serif (Georgia)", stack: 'Georgia, "Times New Roman", serif' },
  wide: { label: "Wide and clear (Verdana)", stack: "Verdana, Geneva, sans-serif" },
  mono: { label: "Monospace", stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
};
export const SIZES = { small: "93.75%", normal: "100%", large: "112.5%" };

// A colour group is all-or-nothing: you can't set the background without the text that sits on it.
export const GROUPS = {
  page: ["background", "surface", "text", "link"],
  buttons: ["button", "buttonText"],
  header: ["header", "headerText"],
};
// Pairs that must stay readable (WCAG AA for normal text is 4.5:1).
export const PAIRS = [
  ["text", "background", "Text on the page background"],
  ["text", "surface", "Text on cards"],
  ["link", "background", "Links on the page background"],
  ["link", "surface", "Links on cards"],
  ["buttonText", "button", "Button text"],
  ["headerText", "header", "Top bar text"],
];
export const MIN_CONTRAST = 4.5;

export const DEFAULT_THEME = { siteName: "", font: "system", fontSize: "normal", colours: {} };

const HEX = /^#[0-9a-f]{6}$/i;
const channel = v => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const luminance = hex => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

export function cleanTheme(input) {
  const t = input || {};
  const siteName =
    t.siteName === undefined ? "" : String(t.siteName).replace(/[<>]/g, "").trim().slice(0, 60);
  const font = t.font ?? "system",
    fontSize = t.fontSize ?? "normal";
  if (!FONTS[font]) return { error: "Choose one of the listed fonts" };
  if (!SIZES[fontSize]) return { error: "Text size must be small, normal or large" };

  const given = t.colours && typeof t.colours === "object" && !Array.isArray(t.colours) ? t.colours : {};
  const allowed = Object.values(GROUPS).flat();
  const colours = {};
  for (const [k, v] of Object.entries(given)) {
    if (!allowed.includes(k)) return { error: `Unknown colour "${k}"` };
    if (v === null || v === "") continue;
    if (typeof v !== "string" || !HEX.test(v)) return { error: `"${k}" must be a colour like #1a2b3c` };
    colours[k] = v.toLowerCase();
  }
  for (const [group, keys] of Object.entries(GROUPS)) {
    const set = keys.filter(k => colours[k]);
    if (set.length && set.length < keys.length)
      return { error: `Set all the ${group} colours together (${keys.join(", ")}), or none of them` };
  }
  for (const [fg, bg, label] of PAIRS)
    if (colours[fg] && colours[bg] && contrast(colours[fg], colours[bg]) < MIN_CONTRAST)
      return {
        error: `${label} is too hard to read (contrast ${contrast(colours[fg], colours[bg]).toFixed(1)}:1; it needs at least ${MIN_CONTRAST}:1)`,
      };
  return { value: { siteName, font, fontSize, colours } };
}

// Only validated values reach here (fixed hex colours, fixed font stacks), so nothing user-typed is ever put in the CSS.
export function themeCss(t) {
  const c = t.colours,
    v = [`--font:${FONTS[t.font].stack}`];
  let scheme = "";
  if (c.background) {
    v.push(
      `--bg:${c.background}`,
      `--surface:${c.surface}`,
      `--text:${c.text}`,
      `--link:${c.link}`,
      `--muted:color-mix(in srgb, ${c.text} 68%, ${c.background})`,
      `--border:color-mix(in srgb, ${c.text} 22%, ${c.background})`,
    );
    scheme = `color-scheme:${luminance(c.background) < 0.4 ? "dark" : "light"};`;
  }
  if (c.button) v.push(`--accent:${c.button}`, `--accent-text:${c.buttonText}`);
  if (c.header) v.push(`--header:${c.header}`, `--header-text:${c.headerText}`);
  return `:root{${v.join(";")};${scheme}}\nhtml{font-size:${SIZES[t.fontSize]}}\n`;
}

export function mountTheme({ app, db, requireCapability, events }) {
  const read = () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'theme'").pluck().get();
    if (!row) return DEFAULT_THEME;
    const checked = cleanTheme(JSON.parse(row));
    return checked.value || DEFAULT_THEME;
  };

  // Public: the sign-in page needs the look and the site name before anyone is signed in.
  app.get("/api/theme", (req, res) => res.json(read()));
  app.get("/api/theme/options", (req, res) =>
    res.json({
      fonts: Object.entries(FONTS).map(([key, f]) => ({ key, label: f.label, stack: f.stack })),
      sizes: Object.keys(SIZES),
      minContrast: MIN_CONTRAST,
    }),
  );
  app.get("/theme.css", (req, res) =>
    res.type("css").set("Cache-Control", "no-cache").send(themeCss(read())),
  );

  app.put("/api/admin/theme", requireCapability("theme:manage"), (req, res) => {
    const r = cleanTheme(req.body);
    if (r.error) return bad(res, r.error);
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('theme', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(JSON.stringify(r.value), now());
    events.emit("theme.changed", {
      actor: req.user,
      target: target("theme", "site", r.value.siteName || "lightlms"),
      detail: {
        font: r.value.font,
        fontSize: r.value.fontSize,
        customColours: Object.keys(r.value.colours).length > 0,
      },
    });
    res.json(r.value);
  });
  app.delete("/api/admin/theme", requireCapability("theme:manage"), (req, res) => {
    db.prepare("DELETE FROM settings WHERE key = 'theme'").run();
    events.emit("theme.reset", { actor: req.user, target: target("theme", "site") });
    res.json(DEFAULT_THEME);
  });
}
