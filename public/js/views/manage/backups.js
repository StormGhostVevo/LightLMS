import { api } from "../../api.js";
import { h, notice, when, put, add, guarded, th } from "../../dom.js";

const size = bytes =>
  bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const KIND = {
  "": "Scheduled or manual",
  "pre-migrate": "Before an update",
  "pre-restore": "Before a restore",
};

export async function backupsView(main, { user }) {
  if (user.role !== "admin")
    return void put(main, h("h1", null, "Backups"), notice("Only administrators can manage backups."));
  const msg = h("div");
  const body = h("tbody");
  const summary = h("p", { class: "hint" });

  async function load() {
    const { backups, everyHours, keep } = await api("/admin/backups");
    put(
      summary,
      everyHours > 0
        ? `A backup is made automatically every ${everyHours} hour${everyHours === 1 ? "" : "s"}, and the newest ${keep} are kept.`
        : "Automatic backups are switched off on this server.",
    );
    put(body);
    add(
      body,
      backups.map(b =>
        h(
          "tr",
          null,
          h("td", null, when(b.createdAt)),
          h("td", null, KIND[b.label] ?? b.label),
          h("td", null, size(b.bytes)),
          h(
            "td",
            null,
            h(
              "a",
              {
                href: `/api/admin/backups/${b.name}/download`,
                download: b.name,
                "aria-label": `Download the backup from ${when(b.createdAt)}`,
              },
              "Download",
            ),
          ),
        ),
      ),
    );
    if (!backups.length) add(body, h("tr", null, h("td", { colspan: 4, class: "hint" }, "No backups yet.")));
  }

  const make = h("button", { type: "button" }, "Back up now");
  make.addEventListener("click", async () => {
    const done = await guarded(make, msg, () => api("/admin/backups", { method: "POST" }));
    if (done) {
      await load();
      put(msg, notice("Backup made and checked.", "ok"));
    }
  });

  put(
    main,
    h("p", null, h("a", { href: "#/manage" }, "All courses")),
    h("h1", null, "Backups"),
    msg,
    summary,
    h(
      "div",
      { class: "notice warn" },
      "A backup holds everything, including people's details and password hashes. Keep downloaded copies somewhere private. ",
      "Backups stored on the same disk as the site do not protect you if that disk is lost, so download copies regularly or copy them elsewhere automatically.",
    ),
    h("p", null, make),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        null,
        h("caption", { class: "sr" }, "Backups, newest first"),
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["Made", "Kind", "Size", ""].map(t => th(t)),
          ),
        ),
        body,
      ),
    ),
    h(
      "p",
      { class: "hint" },
      "To restore a backup, stop the server and run the restore command. See the deployment guide.",
    ),
  );
  await load();
}
