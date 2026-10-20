import { api } from "../../api.js";
import { h, notice, field, guarded } from "../../dom.js";

export function detailsTab(body, { id, course, reload }) {
  const msg = h("div");
  const title = h("input", { type: "text", maxlength: 200, value: course.title });
  const description = h("textarea", { rows: 3, maxlength: 1000 }, course.description);
  const select = (options, value) => h("select", null, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  const enrolment = select([["manual", "Staff enrol people"], ["open", "Anyone signed in can join"]], course.enrolment);
  const completion = select([["both", "Every lesson done and the quiz passed"], ["lessons", "Every lesson done"], ["quiz", "Quiz passed"]], course.completion_rule);
  const showAnswers = select([["after_pass", "After they pass"], ["always", "Straight after each attempt"], ["never", "Never"]], course.show_answers);
  const passMark = h("input", { type: "number", min: 0, max: 100, step: 1, value: course.pass_mark });
  const attempts = h("input", { type: "number", min: 1, max: 50, step: 1, value: course.max_attempts ?? "" });
  const cert = h("input", { type: "checkbox", checked: !!course.certificate_enabled });
  const save = h("button", { type: "submit" }, "Save settings");

  const del = h("button", { type: "button", class: "danger", onclick: async e => {
      if (!confirm("Delete this draft course? Its lessons, questions, enrolments and results are removed for good.")) return;
      if (await guarded(e.target, msg, () => api(`/admin/courses/${id}`, { method: "DELETE" }))) location.hash = "#/manage";
    } }, "Delete course");

  body.append(
    h("form", { class: "card", novalidate: true, onsubmit: async e => {
        e.preventDefault();
        const done = await guarded(save, msg, () => api(`/admin/courses/${id}`, { method: "PATCH", body: {
          title: title.value, description: description.value, enrolment: enrolment.value, completion: completion.value, showAnswers: showAnswers.value,
          passMark: Number(passMark.value), maxAttempts: attempts.value === "" ? null : Number(attempts.value), certificate: cert.checked } }));
        if (done) { await reload(); document.querySelector("main").prepend(notice("Settings saved.", "ok")); }
      } },
      h("h2", null, "Settings"), msg,
      field("Title", title), field("Description", description),
      field("Who can enrol", enrolment, "Staff can always enrol people from the People tab."),
      field("The course is complete when", completion, "If the course has no approved quiz questions, the quiz part is ignored. Loosening this completes anyone who now qualifies."),
      field("Pass mark (%)", passMark), field("Attempts allowed", attempts, "Leave blank for unlimited."),
      field("Show correct answers", showAnswers, "Controls when learners see which option was right, with the explanation."),
      h("div", { class: "field check" }, cert, h("label", { for: (cert.id = "cert-on") }, "Give a certificate when the course is completed")),
      save),
    h("section", { class: "card" }, h("h2", null, "Delete"),
      course.status === "draft" ? h("p", null, "Deleting a course removes its attempts and results. Certificates already issued stay valid.") : h("p", { class: "hint" }, "Unpublish the course before you can delete it."),
      course.status === "draft" ? del : null));
}
