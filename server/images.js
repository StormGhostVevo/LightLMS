import { randomBytes } from "node:crypto";
import { plain } from "./ai.js";

const now = () => new Date().toISOString();
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// The file's own first bytes decide what it is. Whatever the browser or the caller claims is ignored,
// and SVG is not allowed at all because it can carry scripts.
export function sniff(b) {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length > 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  return null;
}

export const imageOf = row => (row.image_key ? { url: `/media/${row.image_key}`, alt: row.image_alt } : null);

export function mountImages({ app, admin, db, course, touch }) {
  // Body: { data: "<base64>", alt: "...", decorative?: true }. One cover image per course; a new one replaces the old.
  admin.put("/courses/:id/image", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const { data, decorative } = req.body || {};
    if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return bad(res, "Send the image as base64 text in { data }");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) return bad(res, "That image is over 2 MB. Use a smaller one.", 413);
    const mime = sniff(bytes);
    if (!mime) return bad(res, "Use a PNG, JPEG, WebP or GIF image");
    const alt = decorative === true ? "" : plain(req.body.alt).slice(0, 200);
    if (decorative !== true && !alt) return bad(res, "Describe the image for people who can't see it, or mark it as decorative");

    const key = randomBytes(16).toString("base64url");
    db.transaction(() => {
      db.prepare("DELETE FROM images WHERE course_id = ?").run(c.id);
      db.prepare("INSERT INTO images (key, course_id, mime, bytes, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(key, c.id, mime, bytes, bytes.length, now());
      db.prepare("UPDATE courses SET image_key = ?, image_alt = ? WHERE id = ?").run(key, alt, c.id);
      touch(c.id);
    })();
    res.json({ url: `/media/${key}`, alt });
  });

  admin.delete("/courses/:id/image", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    db.transaction(() => {
      db.prepare("DELETE FROM images WHERE course_id = ?").run(c.id);
      db.prepare("UPDATE courses SET image_key = NULL, image_alt = '' WHERE id = ?").run(c.id);
      touch(c.id);
    })();
    res.status(204).end();
  });

  // Public, but only reachable with the random key. An image never changes under its key, so it can be cached for good.
  app.get("/media/:key", (req, res) => {
    const img = db.prepare("SELECT mime, bytes FROM images WHERE key = ?").get(req.params.key);
    if (!img) return res.status(404).type("text").send("Not found");
    res.set({ "Content-Type": img.mime, "Cache-Control": "public, max-age=31536000, immutable", "Content-Disposition": "inline" }).send(img.bytes);
  });
}
