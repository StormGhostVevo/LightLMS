import { api } from "../api.js";
import { h, notice, progressBar, put, add } from "../dom.js";

export async function coursesView(main, { user }) {
  const [mine, available] = await Promise.all([api("/courses"), api("/courses/available")]);
  const msg = h("div");
  const cover = c =>
    c.image ? h("img", { class: "cover", src: c.image.url, alt: c.image.alt, loading: "lazy" }) : null;
  const card = c =>
    h(
      "article",
      { class: `card course${c.image ? " has-cover" : ""}` },
      cover(c),
      h(
        "div",
        { class: c.image ? "card-body" : null },
        h("h3", null, h("a", { href: `#/course/${c.id}` }, c.title)),
        c.description ? h("p", null, c.description) : null,
        progressBar(c.percent, `Progress in ${c.title}`),
        c.completed ? h("p", { class: "badge" }, "Completed") : null,
      ),
    );

  put(
    main,
    h("h1", null, user.name ? `Welcome, ${user.name}` : "My courses"),
    msg,
    mine.length
      ? h("div", { class: "grid" }, mine.map(card))
      : h(
          "p",
          { class: "hint" },
          "You're not enrolled in any courses yet. Your administrator can enrol you, or join an open course below.",
        ),
    available.length
      ? h(
          "section",
          null,
          h("h2", null, "Open courses"),
          h(
            "div",
            { class: "grid" },
            available.map(c =>
              h(
                "article",
                { class: `card course${c.image ? " has-cover" : ""}` },
                cover(c),
                h(
                  "div",
                  { class: c.image ? "card-body" : null },
                  h("h3", null, c.title),
                  c.description ? h("p", null, c.description) : null,
                  h(
                    "button",
                    {
                      onclick: async e => {
                        e.target.disabled = true;
                        put(msg);
                        try {
                          await api(`/courses/${c.id}/enrol`, { method: "POST" });
                          location.hash = `#/course/${c.id}`;
                        } catch (err) {
                          e.target.disabled = false;
                          add(msg, notice(err.message));
                        }
                      },
                    },
                    "Enrol",
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}
