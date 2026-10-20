import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { rateLimit } from "express-rate-limit";
import { bad } from "../http.js";
import { target } from "../events.js";
import { BACKUP_NAME, createBackup, listBackups, pruneBackups } from "../backup.js";

/**
 * Admins can see the backups, make one now, and download one (to keep a copy somewhere else). A backup holds
 * everything, including people's details, so these routes are admin-only, audited, and never cached.
 * The folder's path is never sent to the browser.
 */
export function mountAdminBackups({ admin, db, config, events }) {
  const dir = config.backupDir;
  const configured = (req, res, next) =>
    dir ? next() : bad(res, "Backups aren't set up on this server.", 503);
  const makeLimit = rateLimit({
    windowMs: 10 * 60_000,
    limit: 6,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "That's a lot of backups in a short time. Try again in a few minutes." },
  });

  admin.get("/backups", configured, (req, res) =>
    res.json({
      backups: listBackups(dir),
      everyHours: config.backupEveryHours ?? 0,
      keep: config.backupKeep ?? 14,
    }),
  );

  admin.post("/backups", configured, makeLimit, async (req, res) => {
    const b = await createBackup(db, dir);
    pruneBackups(dir, { keep: config.backupKeep ?? 14 });
    events.emit("backup.created", {
      actor: req.user,
      target: target("backup", b.name, b.name),
      detail: { bytes: b.bytes },
    });
    res.status(201).json({ name: b.name, bytes: b.bytes, createdAt: b.createdAt });
  });

  admin.get("/backups/:name/download", configured, (req, res) => {
    const { name } = req.params;
    if (!BACKUP_NAME.test(name)) return bad(res, "That isn't a backup name.", 400); // also what stops "../" and friends
    const file = join(dir, name);
    if (!existsSync(file)) return bad(res, "That backup doesn't exist any more.", 404);
    events.emit("backup.downloaded", { actor: req.user, target: target("backup", name, name) });
    res.set({
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
}
