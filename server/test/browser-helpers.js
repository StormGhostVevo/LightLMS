import { JSDOM } from "jsdom";
import axe from "axe-core";

/**
 * A pretend browser for testing the pages in public/js. It is a real DOM (jsdom) wired to a real test server, so a
 * page's own code runs exactly as it does for a person: fetching from the API, building elements, handling clicks.
 * It does not do layout or paint, so it checks behaviour and content, not looks.
 *
 * @param {import("./helpers.js").TestApp} app
 * @param {{ html?: string }} [options] a whole page to start from (for example public/index.html); by default an empty page
 */
export function openBrowser(app, { html } = {}) {
  const dom = new JSDOM(html ?? "<!doctype html><body></body>", {
    url: `${app.base}/`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // Things jsdom doesn't implement but the pages call.
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  window.matchMedia = /** @type {any} */ (() => ({ matches: false }));
  const dialogs = { confirm: () => true, prompt: () => "", alert: () => {} };
  window.confirm = () => dialogs.confirm();
  window.prompt = () => dialogs.prompt();
  window.alert = () => dialogs.alert();

  // The pages use these as globals, so point the globals at this pretend browser for the length of the test.
  const names = [
    "window",
    "document",
    "location",
    "CustomEvent",
    "Event",
    "HTMLElement",
    "Node",
    "getSelection",
    "matchMedia",
    "prompt",
    "confirm",
    "alert",
  ];
  const saved = Object.fromEntries(names.map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  for (const n of names) {
    const value = n === "getSelection" ? () => window.getSelection() : n === "window" ? window : window[n];
    Object.defineProperty(globalThis, n, { value, configurable: true, writable: true });
  }

  // Cookies: Node's fetch has no cookie jar, so keep the session cookie the way a browser would.
  const realFetch = globalThis.fetch;
  let cookie = "";
  globalThis.fetch = /** @type {any} */ (
    async (url, init = {}) => {
      const res = await realFetch(app.base + url, {
        ...init,
        headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = /Max-Age=0/i.test(set) ? "" : set.split(";")[0];
      return res;
    }
  );
  const events = [];
  document.addEventListener("signed-out", () => events.push("signed-out"));
  document.addEventListener("must-change-password", () => events.push("must-change-password"));

  // With a whole page, the page itself makes its own <main>; otherwise one is made to show a view in.
  const main = html ? document.body : document.createElement("main");
  if (!html) document.body.append(main);

  /** Waits until `check` returns something truthy (pages fetch and render asynchronously). */
  const until = async (check, what = "the page to change", ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > end)
        throw new Error(`Timed out waiting for ${what}. The page says: "${main.textContent.slice(0, 300)}"`);
      await new Promise(r => setTimeout(r, 15));
    }
  };

  const api = {
    document,
    window,
    main,
    events,
    dialogs,
    /** Everything the page shows as text. */
    text: () => main.textContent,
    $: (sel, root = main) => root.querySelector(sel),
    $$: (sel, root = main) => [...root.querySelectorAll(sel)],
    /** The first element matching `sel` whose text is exactly `text`. */
    byText: (sel, text, root = main) =>
      [...root.querySelectorAll(sel)].find(e => e.textContent.trim() === text) ?? null,
    /** Presses a button by its label, and says so loudly if it isn't there. */
    async press(label, root = main) {
      const b = await until(() => api.byText("button", label, root), `a "${label}" button`);
      b.click();
    },
    /** Fills a field. */
    fill(el, value) {
      el.value = value;
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
      el.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    until,
    /**
     * Checks what is currently shown against the WCAG 2.1 and 2.2 level A and AA rules (axe-core).
     * Colour contrast can't be measured without a real screen; the default colours are checked separately.
     * @returns {Promise<string[]>} one readable line per problem found
     */
    async axeProblems(context = main) {
      if (!window.axe) window.eval(axe.source);
      const result = await window.axe.run(context, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
        },
        // Both need a real screen or canvas. Contrast is checked on the palettes; label-in-name is checked by hand in the tests.
        rules: { "color-contrast": { enabled: false }, "label-content-name-mismatch": { enabled: false } },
      });
      return result.violations.flatMap(v =>
        v.nodes.map(
          n => `${v.id} (${v.impact}): ${v.help} | ${n.target.join(" ")} | ${n.html.slice(0, 120)}`,
        ),
      );
    },
    /** Waits out any pending work, then fails if the page shows a leaked "null" or "undefined". */
    async settled() {
      await new Promise(r => setTimeout(r, 60));
      const bad = /\b(null|undefined|NaN|\[object Object\])\b/.exec(main.textContent);
      if (bad) throw new Error(`The page shows "${bad[0]}": ${main.textContent.slice(0, 300)}`);
    },
    /** Signs in through the real login call, as a person would after the form. */
    async signIn(email, password) {
      const res = await globalThis.fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      return res.json();
    },
    /** Shows a view in the main area, the way app.js does. */
    async show(view, ctx = {}, params = []) {
      main.replaceChildren();
      await view(main, { params, setUser() {}, reloadTheme: async () => {}, ...ctx });
    },
    close() {
      globalThis.fetch = realFetch;
      for (const n of names) {
        if (saved[n]) Object.defineProperty(globalThis, n, saved[n]);
        else delete globalThis[n];
      }
      window.close();
    },
  };
  return api;
}
