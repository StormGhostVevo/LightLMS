import { api } from "../api.js";
import { h, notice, progressBar, when } from "../dom.js";

export async function courseView(main, { params }) {
  const id = params[0];
  const [course, initial, initialHistory] = await Promise.all([api(`/courses/${id}`), api(`/courses/${id}/progress`), api(`/courses/${id}/attempts`)]);
  let progress = initial, history = initialHistory, certificate = null;

  const message = h("div");                                   // errors from marking lessons, loading attempts
  const progressBox = h("section", { class: "card", "aria-label": "Your progress" });
  const lessonButtons = new Map();
  const quizBody = h("div");

  const fail = err => { message.replaceChildren(notice(err.message)); message.scrollIntoView({ block: "nearest" }); };

  // ---- progress ----
  async function drawProgress() {
    if (progress.completed && !certificate) certificate = await api(`/courses/${id}/certificate`).catch(() => null);
    const need = [];
    if (progress.rule !== "quiz") need.push("mark every lesson as done");
    if (progress.quiz.required) need.push(`pass the quiz (${course.passMark}% or more)`);
    progressBox.replaceChildren(
      h("h2", null, "Your progress"),
      progressBar(progress.percent, "Course progress"),
      progress.completed
        ? h("p", null, h("span", { class: "badge" }, "Completed"), " ", certificate ? h("a", { href: certificate.url, target: "_blank", rel: "noopener" }, "View your certificate") : null)
        : h("p", { class: "hint" }, need.length ? `To complete this course: ${need.join(" and ")}.` : "There's nothing to complete yet."));
    for (const l of progress.lessons) lessonButtons.get(l.id)?.(l.completed);
  }

  // ---- lessons ----
  const lessonEl = (lesson, n) => {
    const done = () => progress.lessons.find(l => l.id === lesson.id)?.completed;
    const btn = h("button", { type: "button", class: "secondary" });
    const paint = d => { btn.textContent = d ? "Done. Undo" : "Mark as done"; btn.classList.toggle("done", !!d); };
    lessonButtons.set(lesson.id, paint);
    paint(done());
    btn.addEventListener("click", async () => {
      btn.disabled = true; message.replaceChildren();
      try {
        progress = await api(`/courses/${id}/lessons/${lesson.id}/complete`, { method: done() ? "DELETE" : "POST" });
        await drawProgress();
      } catch (err) { fail(err); }
      finally { btn.disabled = false; }
    });
    return h("details", { class: "lesson", open: n === 0 },
      h("summary", null, `${n + 1}. ${lesson.title}`),
      h("div", { class: "lesson-body", html: lesson.body }),            // sanitised on the server before it was saved
      h("p", null, btn));
  };

  // ---- quiz ----
  const attemptsLeft = () => course.maxAttempts == null || history.attemptsUsed < course.maxAttempts;
  const reloadHistory = async () => { history = await api(`/courses/${id}/attempts`); };

  function intro() {
    const n = course.questions.length;
    if (!n) return void quizBody.replaceChildren(h("p", { class: "hint" }, "This course doesn't have a quiz yet."));
    quizBody.replaceChildren(
      h("p", null, `${n} question${n === 1 ? "" : "s"}. Pass mark ${course.passMark}%. `,
        course.maxAttempts == null ? "You can attempt it as many times as you like." : `Attempt ${Math.min(history.attemptsUsed + 1, course.maxAttempts)} of ${course.maxAttempts} available.`),
      history.passed ? h("p", null, h("span", { class: "badge" }, "Passed")) : null,
      attemptsLeft() ? h("button", { onclick: form }, history.attemptsUsed ? "Take the quiz again" : "Start the quiz")
        : h("p", { class: "notice error" }, "You've used all your attempts for this quiz."),
      history.attempts.length ? h("div", null, h("h3", null, "Your attempts"),
        h("ul", { class: "list" }, history.attempts.map(a => h("li", null,
          `${when(a.submittedAt)}: ${a.score} of ${a.total} (${a.percent}%), ${a.passed ? "passed" : "not passed"} `,
          h("button", { class: "link", onclick: async () => {
              try { result(await api(`/attempts/${a.id}`)); } catch (err) { fail(err); }
            } }, "Review"))))) : null);
  }

  function form() {
    const error = h("div");
    const groups = course.questions.map((q, i) => h("fieldset", { class: "question" },
      h("legend", null, `${i + 1}. ${q.prompt}`),
      q.options.map((opt, k) => h("label", { class: "choice" }, h("input", { type: "radio", name: `q${q.id}`, value: k }), h("span", null, opt)))));
    const submit = h("button", { type: "submit" }, "Submit answers");
    quizBody.replaceChildren(h("form", { novalidate: true, onsubmit: async e => {
        e.preventDefault();
        error.replaceChildren();
        const answers = {};
        for (const q of course.questions) {
          const picked = e.target.querySelector(`input[name="q${q.id}"]:checked`);
          if (picked) answers[q.id] = Number(picked.value);
        }
        const missing = course.questions.length - Object.keys(answers).length;
        if (missing) { error.append(notice(`Answer every question before submitting (${missing} left).`)); error.scrollIntoView({ block: "center" }); return; }   // an unanswered question would use up an attempt
        submit.disabled = true;
        try {
          const attempt = await api(`/courses/${id}/quiz`, { method: "POST", body: { answers } });
          await reloadHistory();
          progress = await api(`/courses/${id}/progress`);
          await drawProgress();
          result(attempt);
        } catch (err) { submit.disabled = false; error.append(notice(err.message)); }
      } },
      error, groups, h("p", null, submit, " ", h("button", { type: "button", class: "secondary", onclick: intro }, "Cancel"))));
    quizBody.scrollIntoView({ block: "start" });
  }

  function result(a) {
    const revealed = a.results.some(r => "answer" in r);
    quizBody.replaceChildren(
      h("div", { role: "status", class: `notice ${a.passed ? "ok" : "error"}` },
        `You scored ${a.score} of ${a.total} (${a.percent}%). The pass mark is ${a.passMark}%. `, h("strong", null, a.passed ? "Passed." : "Not passed yet.")),
      h("p", { class: "hint" }, `Attempt taken ${when(a.submittedAt)}.`),
      !revealed ? h("p", { class: "hint" }, "The correct answers aren't shown for this attempt.") : null,
      h("ol", { class: "results" }, a.results.map(r => h("li", { class: r.correct ? "right" : "wrong" },
        h("p", { class: "q" }, r.prompt),
        h("p", null, `Your answer: ${r.chosen == null ? "No answer" : r.options[r.chosen]} `, h("strong", null, r.correct ? "(Correct)" : "(Incorrect)")),
        revealed && !r.correct ? h("p", null, `Correct answer: ${r.options[r.answer]}`) : null,
        revealed && r.explanation ? h("p", { class: "hint" }, r.explanation) : null))),
      h("p", null, attemptsLeft() ? h("button", { onclick: form }, "Try again") : null, " ", h("button", { class: "secondary", onclick: intro }, "Back to quiz")));
    quizBody.scrollIntoView({ block: "start" });
  }

  main.replaceChildren(
    h("p", null, h("a", { href: "#/" }, "Back to my courses")),
    h("h1", null, course.title),
    course.description ? h("p", { class: "lead" }, course.description) : null,
    message, progressBox,
    h("section", null, h("h2", null, "Lessons"), course.lessons.map(lessonEl)),
    h("section", { class: "quiz" }, h("h2", null, "Quiz"), quizBody));
  await drawProgress();
  intro();
}
