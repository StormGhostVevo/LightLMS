import { randomBytes } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { plain } from "./ai.js";
import { now, bad } from "./http.js";

// 32 characters with no look-alikes (no 0/O, 1/I), so each byte maps evenly and codes are easy to read out.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newCode = () => {
  const b = randomBytes(10);
  const s = Array.from(b, x => ALPHABET[x % 32]).join("");
  return `LL-${s.slice(0, 5)}-${s.slice(5)}`;
};
export const normaliseCode = c =>
  String(c ?? "")
    .toUpperCase()
    .replace(/[\s]/g, "");

const esc = s =>
  String(s ?? "").replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// Issues the certificate for a completed course, if the course has certificates on and none exists yet.
export function issueCertificate(db, c, userId) {
  if (!c.certificate_enabled) return null;
  const done = db
    .prepare("SELECT completed_at FROM course_completions WHERE course_id = ? AND user_id = ?")
    .get(c.id, userId);
  if (!done) return null;
  const existing = db
    .prepare("SELECT * FROM certificates WHERE course_id = ? AND user_id = ?")
    .get(c.id, userId);
  if (existing) return existing;
  const u = db.prepare("SELECT name, email FROM users WHERE id = ?").get(userId);
  for (let tries = 0; tries < 5; tries++) {
    try {
      db.prepare(
        "INSERT INTO certificates (code, user_id, course_id, recipient_name, course_title, issued_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(newCode(), userId, c.id, u.name || u.email, c.title, done.completed_at);
      return db.prepare("SELECT * FROM certificates WHERE course_id = ? AND user_id = ?").get(c.id, userId);
    } catch (err) {
      if (!String(err.message).includes("certificates.code")) throw err; // only a code clash is worth retrying
    }
  }
  throw new Error("Couldn't generate a unique certificate code");
}

// Covers completions that happened before certificates existed or while a course had them switched off.
const issueMissingForUser = db => userId =>
  db
    .prepare(
      `SELECT c.* FROM course_completions cc JOIN courses c ON c.id = cc.course_id
              WHERE cc.user_id = ? AND c.certificate_enabled = 1
              AND NOT EXISTS (SELECT 1 FROM certificates x WHERE x.course_id = c.id AND x.user_id = cc.user_id)`,
    )
    .all(userId)
    .forEach(c => issueCertificate(db, c, userId));
const issueMissingForCourse = db => c => {
  if (c.certificate_enabled)
    db.prepare(
      "SELECT user_id FROM course_completions WHERE course_id = ? AND user_id NOT IN (SELECT user_id FROM certificates WHERE course_id = ?)",
    )
      .pluck()
      .all(c.id, c.id)
      .forEach(uid => issueCertificate(db, c, uid));
};

const mine = r => ({
  id: r.id,
  code: r.code,
  courseId: r.course_id,
  courseTitle: r.course_title,
  recipientName: r.recipient_name,
  issuedAt: r.issued_at,
  revoked: !!r.revoked_at,
  url: `/certificate/${r.code}`,
});

export function mountCertificates({ app, admin, db, config, course, visible, requireLogin }) {
  const forUser = issueMissingForUser(db),
    forCourse = issueMissingForCourse(db);

  // ---- learner ----
  app.get("/api/certificates", requireLogin, (req, res) => {
    forUser(req.user.id);
    res.json(
      db
        .prepare("SELECT * FROM certificates WHERE user_id = ? ORDER BY issued_at DESC")
        .all(req.user.id)
        .map(mine),
    );
  });

  app.get("/api/courses/:id/certificate", requireLogin, (req, res) => {
    const c = visible(req, res);
    if (!c) return;
    issueCertificate(db, c, req.user.id);
    const row = db
      .prepare("SELECT * FROM certificates WHERE course_id = ? AND user_id = ?")
      .get(c.id, req.user.id);
    row
      ? res.json(mine(row))
      : bad(
          res,
          c.certificate_enabled
            ? "Complete the course to earn a certificate"
            : "This course doesn't issue certificates",
          404,
        );
  });

  // ---- public verification: anyone holding a code can check it. Exposes only name, course, date and status. ----
  const lookupLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many lookups. Try again in a minute." },
  });
  const find = code => db.prepare("SELECT * FROM certificates WHERE code = ?").get(normaliseCode(code));
  const fmt = iso =>
    new Intl.DateTimeFormat("en-AU", {
      dateStyle: "long",
      timeZone: config.timeZone || "Australia/Sydney",
    }).format(new Date(iso));

  app.get("/api/verify/:code", lookupLimit, (req, res) => {
    const r = find(req.params.code);
    if (!r) return res.status(404).json({ valid: false });
    res.json({
      valid: !r.revoked_at,
      revoked: !!r.revoked_at,
      recipientName: r.recipient_name,
      courseTitle: r.course_title,
      issuedAt: r.issued_at,
      code: r.code,
    });
  });

  // The certificate itself: a printable page (use the browser's Print / Save as PDF).
  app.get("/certificate/:code", lookupLimit, (req, res) => {
    const r = find(req.params.code);
    res
      .status(r ? 200 : 404)
      .type("html")
      .send(page(r, config, fmt));
  });

  // ---- staff ----
  admin.get("/courses/:id/certificates", (req, res) => {
    const c = course(req.params.id);
    if (!c) return bad(res, "Course not found", 404);
    forCourse(c);
    res.json(
      db
        .prepare(
          `SELECT ce.*, u.email FROM certificates ce JOIN users u ON u.id = ce.user_id WHERE ce.course_id = ? ORDER BY ce.issued_at`,
        )
        .all(c.id)
        .map(r => ({ ...mine(r), email: r.email, revokedReason: r.revoked_reason })),
    );
  });

  // Correct the printed name, or revoke / restore a certificate.
  admin.patch("/certificates/:id", (req, res) => {
    const r = db.prepare("SELECT * FROM certificates WHERE id = ?").get(req.params.id);
    if (!r) return bad(res, "Certificate not found", 404);
    const b = req.body || {};
    const name = b.recipientName === undefined ? r.recipient_name : plain(b.recipientName).slice(0, 200);
    if (!name) return bad(res, "The certificate needs a name");
    let revokedAt = r.revoked_at,
      reason = r.revoked_reason;
    if (b.revoked === true && !r.revoked_at) {
      revokedAt = now();
      reason = plain(b.reason).slice(0, 300);
    }
    if (b.revoked === false) {
      revokedAt = null;
      reason = "";
    }
    db.prepare(
      "UPDATE certificates SET recipient_name = ?, revoked_at = ?, revoked_reason = ? WHERE id = ?",
    ).run(name, revokedAt, reason, r.id);
    res.json(mine(db.prepare("SELECT * FROM certificates WHERE id = ?").get(r.id)));
  });
}

function page(r, config, fmt) {
  const org = esc(config.orgName || "lightlms");
  const body = !r
    ? `<h1>Certificate not found</h1><p class="small">Check the code and try again. Codes look like LL-7K2QM-9XBTA.</p>`
    : `${r.revoked_at ? `<p class="banner">This certificate has been revoked and is no longer valid.</p>` : ""}
       <p class="small">${org}</p>
       <h1>Certificate of completion</h1>
       <p>This certifies that</p>
       <p class="name">${esc(r.recipient_name)}</p>
       <p>has successfully completed</p>
       <p class="course">${esc(r.course_title)}</p>
       <p class="small">Issued ${esc(fmt(r.issued_at))}</p>
       <p class="small code">Certificate ID ${esc(r.code)}</p>`;
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${r ? "Certificate: " + esc(r.course_title) : "Certificate not found"}</title>
<style>
body{font-family:Georgia,serif;margin:0;padding:24px;background:#f4f1ea;color:#222;display:flex;justify-content:center}
main{background:#fff;border:6px double #b08d3c;max-width:720px;width:100%;box-sizing:border-box;padding:48px 32px;text-align:center}
h1{font-size:2rem;margin:.4em 0 1em}.name{font-size:2rem;margin:.2em 0;font-style:italic}.course{font-size:1.5rem;font-weight:bold;margin:.2em 0 1.5em}
.small{color:#555;font-size:.95rem}.code{font-family:monospace;letter-spacing:.05em}.banner{background:#fde8e8;color:#8a1c1c;padding:10px;font-family:sans-serif}
@media print{body{background:#fff;padding:0}}
</style></head><body><main>${body}</main></body></html>`;
}
