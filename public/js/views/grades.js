import { api } from "../api.js";
import { h, when, put } from "../dom.js";

export async function gradesView(main) {
  const grades = await api("/grades");
  put(main, h("h1", null, "Grades"),
    grades.length
      ? h("div", { class: "table-wrap" }, h("table", null,
          h("caption", { class: "sr" }, "Your best quiz result in each course"),
          h("thead", null, h("tr", null, ["Course", "Attempts", "Best score", "Pass mark", "Result", "Last attempt"].map(t => h("th", { scope: "col" }, t)))),
          h("tbody", null, grades.map(g => h("tr", null,
            h("th", { scope: "row" }, h("a", { href: `#/course/${g.courseId}` }, g.title)),
            h("td", null, g.attempts),
            h("td", null, g.bestPercent == null ? "None yet" : `${g.bestPercent}%`),
            h("td", null, `${g.passMark}%`),
            h("td", null, g.attempts ? (g.passed ? "Passed" : "Not passed yet") : "Not started"),
            h("td", null, when(g.lastAttemptAt) || "None"))))))
      : h("p", { class: "hint" }, "Once you're enrolled in a course, your quiz results appear here."));
}
