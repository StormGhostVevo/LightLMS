import sanitizeHtml from "sanitize-html";

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

// Text only: every tag is removed and whitespace is tidied. The five basic entities are turned back into
// characters, so "R&D" stays "R&D". The result is only ever shown as text (never as HTML), and anything
// that does put it in HTML (certificates, attributes) escapes it again.
export const plain = s => sanitizeHtml(String(s ?? ""), { allowedTags: [], allowedAttributes: {} })
  .replace(/&(amp|lt|gt|quot|#39);/g, m => ENTITIES[m]).replace(/\s+/g, " ").trim();
