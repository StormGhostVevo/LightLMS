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

export function richEditor(initialHtml, label) {
  const area = h("div", { class: "editor-area", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": label, html: initialHtml || "" });
  area.addEventListener("paste", e => {                       // paste as plain text: no styles or markup from other pages
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  const bar = h("div", { class: "editor-bar", role: "toolbar", "aria-label": "Formatting" },
    COMMANDS.map(([name, text, run]) => h("button", { type: "button", class: "secondary small", "aria-label": name, title: name,
      onmousedown: e => e.preventDefault(),                    // keep the selection in the text
      onclick: () => { area.focus(); run(); } }, text)));
  return { el: h("div", { class: "editor" }, bar, area), html: () => area.innerHTML, text: () => area.textContent.trim() };
}
