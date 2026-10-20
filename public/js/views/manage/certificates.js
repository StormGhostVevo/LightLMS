import { api } from "../../api.js";
import { h, notice, when, btn, guarded, put, add } from "../../dom.js";

export async function certificatesTab(body, { id, course }) {
  const list = await api(`/admin/courses/${id}/certificates`);
  const msg = h("div");
  const redraw = async () => { put(body, ); await certificatesTab(body, { id, course }); };

  add(body, h("h2", null, "Certificates"),
    course.certificate_enabled ? null : notice("Certificates are switched off for this course (Settings). Turning them on issues one to everyone who has already completed it.", "warn"),
    msg,
    list.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("caption", { class: "sr" }, "Certificates issued for this course"),
      h("thead", null, h("tr", null, ["Person", "Name on certificate", "Certificate", "Issued", "Status", ""].map(t => h("th", { scope: "col" }, t)))),
      h("tbody", null, list.map(c => {
        const name = h("input", { type: "text", value: c.recipientName, maxlength: 200, "aria-label": `Name on the certificate for ${c.email}` });
        return h("tr", null,
          h("th", { scope: "row" }, c.email),
          h("td", null, h("span", { class: "row" }, name, btn("Save", async e => {
            if (await guarded(e.target, msg, () => api(`/admin/certificates/${c.id}`, { method: "PATCH", body: { recipientName: name.value } }))) put(msg, notice("Name updated.", "ok"));
          }, "secondary small"))),
          h("td", null, h("a", { href: c.url, target: "_blank", rel: "noopener" }, c.code)),
          h("td", null, when(c.issuedAt)),
          h("td", null, c.revoked ? h("span", null, h("span", { class: "badge draft" }, "Revoked"), c.revokedReason ? ` ${c.revokedReason}` : "") : h("span", { class: "badge published" }, "Valid")),
          h("td", null, c.revoked
            ? btn("Restore", async e => { if (await guarded(e.target, msg, () => api(`/admin/certificates/${c.id}`, { method: "PATCH", body: { revoked: false } }))) await redraw(); }, "secondary small")
            : btn("Revoke", async e => {
                const reason = prompt("Why is this certificate being revoked? (shown to staff only)");
                if (reason === null) return;
                if (await guarded(e.target, msg, () => api(`/admin/certificates/${c.id}`, { method: "PATCH", body: { revoked: true, reason } }))) await redraw();
              }, "danger small")));
      }))))
      : h("p", { class: "hint" }, "No certificates yet. They're issued automatically when someone completes the course."));
}
