import { h } from "./dom.js";

// A small rich-text box for lessons: bold, italic, heading, lists, links. It produces HTML, but the server
// sanitises whatever arrives, so this only has to be convenient, not trusted.
const COMMANDS = [
  ["Bold", "B", () => document.execCommand("bold")],
  ["Italic", "I", () => document.execCommand("italic")],
  ["Heading", "H", () => document.execCommand("formatBlock", false, "h3")],
  ["Paragraph", "¶", () => document.execCommand("formatBlock", false, "p")],
  ["Bulleted list", "• List", () => document.execCommand("insertUnorderedList")],
  ["Numbered list", "1. List", () => document.execCommand("insertOrderedList")],
  ["Link", "Link", () => {
    const url = (prompt("Link address (starting with https://)") || "").trim();
    if (/^(https:\/\/|mailto:)/i.test(url)) document.execCommand("createLink", false, url);
    else if (url) alert("Links must start with https:// or mailto:");
  }],
  ["Remove link", "Unlink", () => document.execCommand("unlink")],
];

export function richEditor(initialHtml, label, { uploadImage } = {}) {
  const area = h("div", { class: "editor-area", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": label, html: initialHtml || "" });
  area.addEventListener("paste", e => {                       // paste as plain text: no styles or markup from other pages
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  // The file picker takes focus away, so remember where the cursor was and put the picture back there.
  let saved = null;
  const remember = () => { const sel = getSelection(); if (sel.rangeCount && area.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange(); };
  for (const ev of ["keyup", "mouseup", "input", "blur"]) area.addEventListener(ev, remember);
  const restore = () => {
    area.focus();
    const sel = getSelection(), range = saved || (() => { const r = document.createRange(); r.selectNodeContents(area); r.collapse(false); return r; })();
    sel.removeAllRanges(); sel.addRange(range);
  };
  const attr = v => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const picker = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", class: "sr", tabindex: "-1", "aria-hidden": "true" });
  picker.addEventListener("change", async () => {
    const file = picker.files[0]; picker.value = "";
    if (!file) return;
    // The description is asked for before anything is uploaded, so cancelling costs nothing.
    let alt = prompt("Describe the picture for people who can't see it (for example: A hard hat on a desk).\n\nLeave this blank only if it is purely decoration.");
    if (alt === null) return;
    alt = alt.trim();
    if (!alt && !confirm("No description. Use this picture as decoration only?")) return;
    try {
      const url = await uploadImage(file);
      restore();
      document.execCommand("insertHTML", false, `<img src="${attr(url)}" alt="${attr(alt)}">`);
    } catch (err) { alert(err.message); }
  });

  const tools = COMMANDS.map(([name, text, run]) => h("button", { type: "button", class: "secondary small", "aria-label": name, title: name,
    onmousedown: e => e.preventDefault(),                      // keep the selection in the text
    onclick: () => { area.focus(); run(); } }, text));
  if (uploadImage) tools.push(h("button", { type: "button", class: "secondary small", "aria-label": "Insert picture", title: "Insert picture",
    onmousedown: e => e.preventDefault(), onclick: () => { remember(); picker.click(); } }, "Picture"));
  const bar = h("div", { class: "editor-bar", role: "toolbar", "aria-label": "Formatting" }, tools, picker);
  return { el: h("div", { class: "editor" }, bar, area), html: () => area.innerHTML, text: () => area.textContent.trim() };
}
