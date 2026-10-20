import { api } from "../api.js";
import { h, notice, progressBar, when, put, add } from "../dom.js";

export async function courseView(main, { params }) {
  const id = params[0];
  const [course, initial, initialHistory] = await Promise.all([
    api(`/courses/${id}`),
    api(`/courses/${id}/progress`),
    api(`/courses/${id}/attempts`),
  ]);
  let progress = initial,
    history = initialHistory,
    certificate = null;

  const message = h("div"); // errors from marking lessons, loading attempts
  const progressBox = h("section", { class: "card", "aria-label": "Your progress" });
  const lessonButtons = new Map();
  const quizBody = h("div");

  const fail = err => {
    put(message, notice(err.message));
    message.scrollIntoView({ block: "nearest" });
  };

  // ---- progress ----
  async function drawProgress() {
    if (progress.completed && !certificate)
      certificate = await api(`/courses/${id}/certificate`).catch(() => null);
    const need = [];
    if (progress.rule !== "quiz") need.push("mark every lesson as done");
    if (progress.quiz.required) need.push(`pass the quiz (${course.passMark}% or more)`);
    put(
      progressBox,
      h("h2", null, "Your progress"),
      progressBar(progress.percent, "Course progress"),
      progress.completed
        ? h(
            "p",
            null,
            h("span", { class: "badge" }, "Completed"),
            " ",
            certificate
              ? h("a", { href: certificate.url, target: "_blank", rel: "noopener" }, "View your certificate")
              : null,
          )
        : h(
            "p",
            { class: "hint" },
            need.length
              ? `To complete this course: ${need.join(" and ")}.`
              : "There's nothing to complete yet.",
          ),
    );
    for (const l of progress.lessons) lessonButtons.get(l.id)?.(l.completed);
  }

  // ---- lessons ----
  const lessonEl = (lesson, n) => {
    const done = () => progress.lessons.find(l => l.id === lesson.id)?.completed;
    const btn = h("button", { type: "button", class: "secondary" });
    const paint = d => {
      btn.textContent = d ? "Done. Undo" : "Mark as done";
      btn.classList.toggle("done", !!d);
    };
    lessonButtons.set(lesson.id, paint);
    paint(done());
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      put(message);
      try {
        progress = await api(`/courses/${id}/lessons/${lesson.id}/complete`, {
          method: done() ? "DELETE" : "POST",
        });
        await drawProgress();
      } catch (err) {
        fail(err);
      } finally {
        btn.disabled = false;
      }
    });
    return h(
      "details",
      { class: "lesson", open: n === 0 },
      h("summary", null, `${n + 1}. ${lesson.title}`),
      h("div", { class: "lesson-body", html: lesson.body }), // sanitised on the server before it was saved
      h("p", null, btn),
    );
  };

  // ---- quiz ----
  const attemptsLeft = () => course.maxAttempts == null || history.attemptsUsed < course.maxAttempts;
  const reloadHistory = async () => {
    history = await api(`/courses/${id}/attempts`);
  };

  function intro() {
    const n = course.questions.length;
    if (!n) return void put(quizBody, h("p", { class: "hint" }, "This course doesn't have a quiz yet."));
    put(
      quizBody,
      h(
        "p",
        null,
        `${n} question${n === 1 ? "" : "s"}. Pass mark ${course.passMark}%. `,
        course.maxAttempts == null
          ? "You can attempt it as many times as you like."
          : `Attempt ${Math.min(history.attemptsUsed + 1, course.maxAttempts)} of ${course.maxAttempts} available.`,
      ),
      history.passed ? h("p", null, h("span", { class: "badge" }, "Passed")) : null,
      attemptsLeft()
        ? h("button", { onclick: form }, history.attemptsUsed ? "Take the quiz again" : "Start the quiz")
        : h("p", { class: "notice error" }, "You've used all your attempts for this quiz."),
      history.attempts.length
        ? h(
            "div",
            null,
            h("h3", null, "Your attempts"),
            h(
              "ul",
              { class: "list" },
              history.attempts.map(a =>
                h(
                  "li",
                  null,
                  `${when(a.submittedAt)}: ${a.score} of ${a.total} (${a.percent}%), ${a.passed ? "passed" : "not passed"} `,
                  h(
                    "button",
                    {
                      class: "link",
                      onclick: async () => {
                        try {
                          result(await api(`/attempts/${a.id}`));
                        } catch (err) {
                          fail(err);
                        }
                      },
                    },
                    "Review",
                  ),
                ),
              ),
            ),
          )
        : null,
    );
  }

  // One control per question type. Each returns the element to show and a function that reads the learner's answer
  // (undefined while it is still unanswered).
  function control(q, i) {
    const legend = h("legend", null, `${i + 1}. ${q.prompt}`);
    const name = `q${q.id}`;
    if (q.type === "multiple_response") {
      const boxes = q.options.map((opt, k) => h("input", { type: "checkbox", value: k }));
      return {
        el: h(
          "fieldset",
          { class: "question" },
          legend,
          h("p", { class: "hint" }, "Select all that apply."),
          q.options.map((opt, k) => h("label", { class: "choice" }, boxes[k], h("span", null, opt))),
        ),
        read: () => {
          const picked = boxes.filter(b => b.checked).map(b => Number(b.value));
          return picked.length ? picked : undefined;
        },
      };
    }
    if (q.type === "short_answer" || q.type === "numeric") {
      const input = h("input", {
        type: "text",
        maxlength: q.type === "numeric" ? 40 : 200,
        autocomplete: "off",
        spellcheck: "false",
        inputmode: q.type === "numeric" ? "decimal" : null,
        id: `in-${q.id}`,
      });
      return {
        el: h(
          "fieldset",
          { class: "question" },
          legend,
          h("label", { for: input.id, class: "sr" }, "Your answer"),
          input,
          q.type === "numeric" ? h("p", { class: "hint" }, "Enter a number.") : null,
        ),
        read: () => input.value.trim() || undefined,
      };
    }
    if (q.type === "matching") {
      const selects = q.items.map((item, k) =>
        h(
          "select",
          { id: `m-${q.id}-${k}` },
          h("option", { value: "" }, "Choose..."),
          q.choices.map(c => h("option", { value: c }, c)),
        ),
      );
      return {
        el: h(
          "fieldset",
          { class: "question" },
          legend,
          h("p", { class: "hint" }, "Match each item with its pair."),
          q.items.map((item, k) =>
            h("div", { class: "match-row" }, h("label", { for: selects[k].id }, item), selects[k]),
          ),
        ),
        read: () => (selects.every(sel => sel.value) ? selects.map(sel => sel.value) : undefined),
      };
    }
    // multiple choice and true or false
    return {
      el: h(
        "fieldset",
        { class: "question" },
        legend,
        q.options.map((opt, k) =>
          h(
            "label",
            { class: "choice" },
            h("input", { type: "radio", name, value: k }),
            h("span", null, opt),
          ),
        ),
      ),
      read: () => {
        const picked = quizBody.querySelector(`input[name="${name}"]:checked`);
        return picked ? Number(picked.value) : undefined;
      },
    };
  }

  function form() {
    const error = h("div");
    const controls = course.questions.map(control);
    const submit = h("button", { type: "submit" }, "Submit answers");
    put(
      quizBody,
      h(
        "form",
        {
          novalidate: true,
          onsubmit: async e => {
            e.preventDefault();
            put(error);
            const answers = {};
            course.questions.forEach((q, i) => {
              const a = controls[i].read();
              if (a !== undefined) answers[q.id] = a;
            });
            const missing = course.questions.length - Object.keys(answers).length;
            if (missing) {
              add(error, notice(`Answer every question before submitting (${missing} left).`));
              error.scrollIntoView({ block: "center" });
              return;
            } // an unanswered question would use up an attempt
            submit.disabled = true;
            try {
              const attempt = await api(`/courses/${id}/quiz`, { method: "POST", body: { answers } });
              await reloadHistory();
              progress = await api(`/courses/${id}/progress`);
              await drawProgress();
              result(attempt);
            } catch (err) {
              submit.disabled = false;
              add(error, notice(err.message));
            }
          },
        },
        error,
        controls.map(c => c.el),
        h(
          "p",
          null,
          submit,
          " ",
          h("button", { type: "button", class: "secondary", onclick: intro }, "Cancel"),
        ),
      ),
    );
    quizBody.scrollIntoView({ block: "start" });
  }

  function result(a) {
    const revealed = a.results.some(r => "correctAnswer" in r);
    put(
      quizBody,
      h(
        "div",
        { role: "status", class: `notice ${a.passed ? "ok" : "error"}` },
        `You scored ${a.score} of ${a.total} (${a.percent}%). The pass mark is ${a.passMark}%. `,
        h("strong", null, a.passed ? "Passed." : "Not passed yet."),
      ),
      h("p", { class: "hint" }, `Attempt taken ${when(a.submittedAt)}.`),
      !revealed ? h("p", { class: "hint" }, "The correct answers aren't shown for this attempt.") : null,
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
              `Your answer: ${r.yourAnswer} `,
              h("strong", null, r.correct ? "(Correct)" : "(Incorrect)"),
            ),
            revealed && !r.correct ? h("p", null, `Correct answer: ${r.correctAnswer}`) : null,
            revealed && r.explanation ? h("p", { class: "hint" }, r.explanation) : null,
          ),
        ),
      ),
      h(
        "p",
        null,
        attemptsLeft() ? h("button", { onclick: form }, "Try again") : null,
        " ",
        h("button", { class: "secondary", onclick: intro }, "Back to quiz"),
      ),
    );
    quizBody.scrollIntoView({ block: "start" });
  }

  put(
    main,
    h("p", null, h("a", { href: "#/" }, "Back to my courses")),
    h("h1", null, course.title),
    course.image ? h("img", { class: "banner", src: course.image.url, alt: course.image.alt }) : null,
    course.description ? h("p", { class: "lead" }, course.description) : null,
    message,
    progressBox,
    h("section", null, h("h2", null, "Lessons"), course.lessons.map(lessonEl)),
    h("section", { class: "quiz" }, h("h2", null, "Quiz"), quizBody),
  );
  await drawProgress();
  intro();
}
