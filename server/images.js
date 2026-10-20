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

export const MAX_LESSON_IMAGES = 60, MAX_LESSON_IMAGE_BYTES = 25 * 1024 * 1024;
const KEY = /\/media\/([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g;

// Decodes and checks an uploaded image: base64 text, at most 2 MB, and really a PNG, JPEG, WebP or GIF.
function readImage(body) {
  const data = body?.data;
  if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: "Send the image as base64 text in { data }" };
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) return { error: "That image is over 2 MB. Use a smaller one.", status: 413 };
  const mime = sniff(bytes);
  if (!mime) return { error: "Use a PNG, JPEG, WebP or GIF image" };
  return { bytes, mime };
}

// Lesson images that no lesson uses any more are deleted, but only once they are an hour old, so a picture
// uploaded while someone is still writing a lesson (not saved yet) is never taken away from them.
export function cleanupLessonImages(db, courseId) {
  const used = new Set();
  for (const body of db.prepare("SELECT body FROM lessons WHERE course_id = ?").pluck().all(courseId))
    for (const m of body.matchAll(KEY)) used.add(m[1]);
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const del = db.prepare("DELETE FROM images WHERE key = ?");
  for (const row of db.prepare("SELECT key FROM images WHERE course_id = ? AND kind = 'lesson' AND created_at < ?").all(courseId, cutoff))
    if (!used.has(row.key)) del.run(row.key);
}

export const imageOf = row => (row.image_key ? { url: `/media/${row.image_key}`, alt: row.image_alt } : null);

export function mountImages({ app, admin, db, course, touch }) {
  // Body: { data: "<base64>", alt: "...", decorative?: true }. One cover image per course; a new one replaces the old.
  admin.put("/courses/:id/image", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const { decorative } = req.body || {};
    const img = readImage(req.body);
    if (img.error) return bad(res, img.error, img.status);
    const { bytes, mime } = img;
    const alt = decorative === true ? "" : plain(req.body.alt).slice(0, 200);
    if (decorative !== true && !alt) return bad(res, "Describe the image for people who can't see it, or mark it as decorative");

    const key = randomBytes(16).toString("base64url");
    db.transaction(() => {
      db.prepare("DELETE FROM images WHERE course_id = ? AND kind = 'cover'").run(c.id);
      db.prepare("INSERT INTO images (key, course_id, kind, mime, bytes, size, created_at) VALUES (?, ?, 'cover', ?, ?, ?, ?)").run(key, c.id, mime, bytes, bytes.length, now());
      db.prepare("UPDATE courses SET image_key = ?, image_alt = ? WHERE id = ?").run(key, alt, c.id);
      touch(c.id);
    })();
    res.json({ url: `/media/${key}`, alt });
  });

  // An image to place inside lesson text. The description (alt text) lives in the lesson itself, next to where it is used.
  admin.post("/courses/:id/images", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    const img = readImage(req.body);
    if (img.error) return bad(res, img.error, img.status);
    const { n, total } = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM images WHERE course_id = ? AND kind = 'lesson'").get(c.id);
    if (n >= MAX_LESSON_IMAGES) return bad(res, `A course can have up to ${MAX_LESSON_IMAGES} lesson images`, 409);
    if (total + img.bytes.length > MAX_LESSON_IMAGE_BYTES) return bad(res, "This course's lesson images are over 25 MB in total. Remove some first.", 409);
    const key = randomBytes(16).toString("base64url");
    db.prepare("INSERT INTO images (key, course_id, kind, mime, bytes, size, created_at) VALUES (?, ?, 'lesson', ?, ?, ?, ?)").run(key, c.id, img.mime, img.bytes, img.bytes.length, now());
    res.status(201).json({ url: `/media/${key}` });
  });

  admin.delete("/courses/:id/image", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    db.transaction(() => {
      db.prepare("DELETE FROM images WHERE course_id = ? AND kind = 'cover'").run(c.id);
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
