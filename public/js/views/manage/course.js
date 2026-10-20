import { api } from "../../api.js";
import { h, notice, guarded, put, add } from "../../dom.js";
import { handoff } from "../../state.js";
import { detailsTab } from "./details.js";
import { lessonsTab } from "./lessons.js";
import { questionsTab } from "./questions.js";
import { peopleTab } from "./people.js";
import { resultsTab } from "./results.js";
import { certificatesTab } from "./certificates.js";

/** @type {[string, string, (body: HTMLElement, ctx: any) => void | Promise<any>][]} */
const TABS = [
  ["lessons", "Lessons", lessonsTab],
  ["questions", "Questions", questionsTab],
  ["people", "People", peopleTab],
  ["results", "Results", resultsTab],
  ["certificates", "Certificates", certificatesTab],
  ["settings", "Settings", detailsTab],
];

export async function manageCourseView(main, { params }) {
  const id = params[0];
  const current = TABS.find(t => t[0] === params[1]) || TABS[0];
  let course = await api(`/admin/courses/${id}`);

  const head = h("div"),
    body = h("div");
  const flagsBox = h("div");
  if (handoff.flags?.length) {
    // what the AI wasn't sure about, shown once
    add(
      flagsBox,
      h(
        "div",
        { class: "notice warn", role: "status" },
        h("strong", null, "The AI flagged these for you to check:"),
        h(
          "ul",
          null,
          handoff.flags.map(f => h("li", null, f)),
        ),
      ),
    );
  }
  handoff.flags = null;

  const reload = async () => {
    course = await api(`/admin/courses/${id}`);
    await draw();
  };
  const ctx = () => ({ id, course, reload, main });

  async function draw() {
    const msg = h("div");
    const approved = course.questions.filter(q => q.status === "approved").length;
    const published = course.status === "published";
    const toggle = h(
      "button",
      {
        type: "button",
        class: published ? "secondary" : "",
        onclick: async e => {
          if (
            !published &&
            !approved &&
            !confirm("This course has no approved questions, so learners won't see a quiz. Publish anyway?")
          )
            return;
          if (
            published &&
            !confirm(
              "Unpublishing hides the course from learners. Enrolments and results are kept. Continue?",
            )
          )
            return;
          if (
            await guarded(e.target, msg, () =>
              api(`/admin/courses/${id}/${published ? "unpublish" : "publish"}`, { method: "POST" }),
            )
          )
            await reload();
        },
      },
      published ? "Unpublish" : "Publish",
    );
    put(
      head,
      h("p", null, h("a", { href: "#/manage" }, "All courses")),
      h("h1", null, course.title),
      h(
        "p",
        { class: "row" },
        h("span", { class: `badge ${course.status}` }, published ? "Published" : "Draft"),
        published ? h("a", { href: `#/course/${id}` }, "Preview as a learner") : null,
        toggle,
      ),
      msg,
      h(
        "nav",
        { class: "tabs", "aria-label": "Course sections" },
        TABS.map(([key, label]) =>
          h(
            "a",
            { href: `#/manage/course/${id}/${key}`, "aria-current": key === current[0] ? "page" : null },
            label,
          ),
        ),
      ),
    );
    put(body);
    try {
      await current[2](body, ctx());
    } catch (err) {
      put(body, notice(err.message));
    }
  }

  put(main, head, flagsBox, body);
  await draw();
}
