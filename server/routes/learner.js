import { HttpError } from "../http.js";
import { can } from "../permissions.js";

/**
 * What a signed-in learner can do with courses: see theirs, join open ones, read one they are enrolled in.
 * Correct answers never leave the server (see `courses.learnerView`).
 */
export function mountLearner({ app, courses, enrolment, requireLogin }) {
  /**
   * A published course the person may read: enrolled, or staff previewing. Anything else looks like it doesn't exist.
   * Other route files (quiz, progress, certificates) use this for the same rule.
   */
  const visible = (req, res) => {
    const c = courses.get(req.params.id);
    const allowed =
      c &&
      c.status === "published" &&
      (enrolment.isEnrolled(c.id, req.user.id) || can(req.user, "course:preview", { courseId: c.id }));
    if (!allowed) {
      res.status(404).json({ error: "Course not found" });
      return null;
    }
    return c;
  };

  app.get("/api/courses", requireLogin, (req, res) => res.json(courses.learnerList(req.user.id)));
  app.get("/api/courses/available", requireLogin, (req, res) => res.json(courses.available(req.user.id)));

  app.post("/api/courses/:id/enrol", requireLogin, (req, res) => {
    const c = courses.get(req.params.id);
    if (!c) throw new HttpError(404, "That course isn't open for self-enrolment");
    enrolment.selfEnrol(c, req.user.id);
    res.status(201).json({ id: c.id, enrolled: true });
  });

  app.get("/api/courses/:id", requireLogin, (req, res) => {
    const c = visible(req, res);
    if (c) res.json(courses.learnerView(c));
  });

  return { visible };
}
