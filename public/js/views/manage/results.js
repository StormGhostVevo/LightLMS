import { api } from "../../api.js";
import { h, when, btn, guarded, add } from "../../dom.js";

export async function resultsTab(body, { id }) {
  const g = await api(`/admin/courses/${id}/gradebook`);
  const s = g.summary;
  const stat = (n, label) =>
    h("div", { class: "stat" }, h("strong", null, n ?? "None yet"), h("span", null, label));
  const msg = h("div");

  const attemptsRow = (l, row) => async e => {
    const open = row.nextElementSibling?.classList.contains("detail-row");
    if (open) return void row.nextElementSibling.remove();
    const list = await guarded(e.target, msg, () => api(`/admin/courses/${id}/users/${l.userId}/attempts`));
    if (!list) return;
    row.after(
      h(
        "tr",
        { class: "detail-row" },
        h(
          "td",
          { colspan: 7 },
          list.length
            ? list.map(a =>
                h(
                  "details",
                  null,
                  h(
                    "summary",
                    null,
                    `${when(a.submittedAt)}: ${a.score} of ${a.total} (${a.percent}%), ${a.passed ? "passed" : "not passed"}`,
                  ),
                  h(
                    "ol",
                    { class: "results" },
                    a.results.map(r =>
                      h(
                        "li",
                        { class: r.correct ? "right" : "wrong" },
                        h("p", { class: "q" }, r.prompt),
                        h(
                          "p",
                          null,
                          `Answered: ${r.yourAnswer} ${r.correct ? "(correct)" : `(incorrect; correct was ${r.correctAnswer})`}`,
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : h("p", { class: "hint" }, "No attempts yet."),
        ),
      ),
    );
  };

  add(
    body,
    h("h2", null, "Results"),
    msg,
    h(
      "div",
      { class: "stats" },
      stat(s.enrolled, "enrolled"),
      stat(s.attempted, "tried the quiz"),
      stat(s.passed, `passed (${g.course.passMark}%+)`),
      stat(s.completed, "completed"),
      stat(s.averageBestPercent == null ? null : `${s.averageBestPercent}%`, "average best score"),
    ),
    h("p", null, h("a", { href: `/api/admin/courses/${id}/gradebook.csv`, download: "" }, "Download as CSV")),
    g.learners.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            null,
            h("caption", { class: "sr" }, "Results for each enrolled person"),
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                ["Person", "Lessons done", "Attempts", "Best score", "Passed", "Completed", ""].map(t =>
                  h("th", { scope: "col" }, t),
                ),
              ),
            ),
            h(
              "tbody",
              null,
              g.learners.map(l => {
                const row = h("tr");
                add(
                  row,
                  h("th", { scope: "row" }, l.name ? `${l.name} (${l.email})` : l.email),
                  h("td", null, `${l.lessonsCompleted} of ${s.lessons}`),
                  h("td", null, l.attempts),
                  h("td", null, l.bestPercent == null ? "None" : `${l.bestPercent}%`),
                  h("td", null, l.passed ? "Yes" : "No"),
                  h("td", null, l.completedAt ? when(l.completedAt) : "No"),
                  h(
                    "td",
                    null,
                    l.attempts
                      ? btn("Answers", attemptsRow(l, row), "secondary small", {
                          "aria-label": `Show answers for ${l.email}`,
                        })
                      : null,
                  ),
                );
                return row;
              }),
            ),
          ),
        )
      : h("p", { class: "hint" }, "Nobody is enrolled yet."),
    g.questions.length
      ? h(
          "section",
          null,
          h("h3", null, "Questions people miss most"),
          h(
            "p",
            { class: "hint" },
            "The lowest scores are first. A question most people get wrong may be unclear or may need a better lesson.",
          ),
          h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              null,
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  ["Question", "Answered", "Correct"].map(t => h("th", { scope: "col" }, t)),
                ),
              ),
              h(
                "tbody",
                null,
                g.questions.map(q =>
                  h(
                    "tr",
                    null,
                    h("th", { scope: "row" }, q.prompt),
                    h("td", null, q.attempts),
                    h("td", null, `${q.percentCorrect}%`),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}
