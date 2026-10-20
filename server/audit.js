import { now } from "./http.js";

const MAX_DETAIL = 2000;

/** Writes every event to the audit log. */
export function registerAudit({ db, events }) {
  const insert = db.prepare(
    `INSERT INTO audit_log (at, actor_id, actor_email, action, target_type, target_id, target_label, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  events.observe((name, e) => {
    let detail = JSON.stringify(e.detail ?? {});
    if (detail.length > MAX_DETAIL) detail = JSON.stringify({ note: "detail too long to keep" });
    insert.run(
      now(),
      e.actor?.id ?? null,
      e.actor?.email ?? "",
      name,
      e.target?.type ?? "",
      String(e.target?.id ?? ""),
      (e.target?.label ?? "").slice(0, 200),
      detail,
    );
  });
}

/**
 * The newest entries first. Pass the id of the last entry you have to get the next page.
 * @param {import("better-sqlite3").Database} db
 * @param {{ limit?: number, before?: number, action?: string }} [options]
 */
export function readAudit(db, { limit = 50, before, action } = {}) {
  const size = Math.min(200, Math.max(1, limit));
  /** @type {any[]} */
  const rows = db
    .prepare(
      `SELECT * FROM audit_log WHERE (? IS NULL OR id < ?) AND (? IS NULL OR action = ?) ORDER BY id DESC LIMIT ?`,
    )
    .all(before ?? null, before ?? null, action ?? null, action ?? null, size + 1);
  const page = rows.slice(0, size).map(r => ({
    id: r.id,
    at: r.at,
    actor: r.actor_email,
    action: r.action,
    target: { type: r.target_type, id: r.target_id, label: r.target_label },
    detail: JSON.parse(r.detail),
  }));
  return { entries: page, next: rows.length > size ? page[page.length - 1].id : null };
}

export function mountAudit({ admin, db }) {
  admin.get("/audit", (req, res) => {
    const limit = Number.parseInt(String(req.query.limit), 10) || 50;
    const before = Number.parseInt(String(req.query.before), 10) || undefined;
    const action = typeof req.query.action === "string" && req.query.action ? req.query.action : undefined;
    res.json(readAudit(db, { limit, before, action }));
  });
}
