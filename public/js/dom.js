// Tiny element builder. Text always goes in as text, never as HTML, so nothing a user typed can run.
// The only HTML that reaches the page is lesson content, which the server has already sanitised (see `html`).
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export const clear = el => { while (el.firstChild) el.firstChild.remove(); return el; };

const dateTime = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" });
export const when = iso => (iso ? dateTime.format(new Date(iso)) : "");

export function progressBar(percent, label) {
  return h("div", { class: "progress" },
    h("progress", { value: percent, max: 100, "aria-label": label || "Progress" }),
    h("span", { class: "progress-text" }, `${percent}%`));
}

// A status message that screen readers announce when it changes.
export const notice = (text, kind = "error") => h("p", { class: `notice ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
