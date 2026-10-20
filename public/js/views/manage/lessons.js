import { api } from "../../api.js";
import { h, notice, field, btn, guarded, put, add } from "../../dom.js";
import { richEditor } from "../../editor.js";
import { prepareImage } from "../../image.js";

export function lessonsTab(body, { id, course, reload }) {
  const msg = h("div");
  const lessons = course.lessons;
  const move = async (i, dir) => {
    const order = lessons.map(l => l.id);
    [order[i], order[i + dir]] = [order[i + dir], order[i]];
    if (await guarded(null, msg, () => api(`/admin/courses/${id}/lessons/order`, { method: "PUT", body: { order } }))) await reload();
  };

  // One form for both adding and editing.
  function form(lesson, host) {
    const err = h("div");
    const title = h("input", { type: "text", maxlength: 200, value: lesson?.title || "" });
    const editor = richEditor(lesson?.body, "Lesson content", {
      uploadImage: async file => (await api(`/admin/courses/${id}/images`, { method: "POST", body: { data: await prepareImage(file) } })).url });
    const save = h("button", { type: "submit" }, lesson ? "Save lesson" : "Add lesson");
    put(host, h("form", { class: "card", novalidate: true, onsubmit: async e => {
        e.preventDefault();
        if (!title.value.trim()) return void put(err, notice("A lesson needs a title."));
        if (!editor.text()) return void put(err, notice("A lesson needs some content."));
        const payload = { title: title.value, body: editor.html() };
        const ok = await guarded(save, err, () => lesson ? api(`/admin/lessons/${lesson.id}`, { method: "PATCH", body: payload })
                                                         : api(`/admin/courses/${id}/lessons`, { method: "POST", body: payload }));
        if (ok) await reload();
      } },
      h("h3", null, lesson ? "Edit lesson" : "New lesson"), err, field("Title", title),
      h("div", { class: "field" }, h("span", { class: "label" }, "Content"), editor.el),
      h("p", null, save, " ", btn("Cancel", () => put(host, )))));
    title.focus();
  }

  const addHost = h("div");
  add(body, h("h2", null, "Lessons"), msg,
    lessons.length ? h("ol", { class: "manage-list" }, lessons.map((l, i) => {
      const host = h("div");
      return h("li", null,
        h("div", { class: "row between" }, h("strong", null, l.title),
          h("span", { class: "row" },
            btn("Up", () => move(i, -1), "secondary small", { disabled: i === 0, "aria-label": `Move ${l.title} up` }),
            btn("Down", () => move(i, 1), "secondary small", { disabled: i === lessons.length - 1, "aria-label": `Move ${l.title} down` }),
            btn("Edit", () => form(l, host), "secondary small", { "aria-label": `Edit ${l.title}` }),
            btn("Delete", async e => {
              if (!confirm(`Delete the lesson "${l.title}"? People's ticks for it are removed. Completions already earned stay.`)) return;
              if (await guarded(e.target, msg, () => api(`/admin/lessons/${l.id}`, { method: "DELETE" }))) await reload();
            }, "danger small", { "aria-label": `Delete ${l.title}` }))),
        host);
    })) : h("p", { class: "hint" }, "No lessons yet."),
    addHost, h("p", null, btn("Add a lesson", () => form(null, addHost), "")));
}
