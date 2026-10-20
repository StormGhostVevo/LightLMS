import { test } from "node:test";
import assert from "node:assert/strict";
import { start, quizCourse } from "./helpers.js";
import { GRANTS, can, capabilityFor } from "../permissions.js";

const STAFF = ["course:author", "course:preview", "enrolment:manage", "results:view", "certificate:manage"];
const ADMIN_ONLY = ["user:manage", "theme:manage", "audit:view", "backup:manage"];

test("permissions: the role by capability matrix", () => {
  const roles = { admin: [...STAFF, ...ADMIN_ONLY], author: STAFF, learner: [] };
  assert.deepEqual(Object.keys(GRANTS).sort(), [...STAFF, ...ADMIN_ONLY].sort()); // a new capability must be added to this test
  for (const [role, allowed] of Object.entries(roles))
    for (const capability of Object.keys(GRANTS))
      assert.equal(can({ role }, capability), allowed.includes(capability), `${role} / ${capability}`);
  assert.equal(can(null, "course:author"), false);
  assert.equal(can(undefined, "course:author"), false);
  assert.equal(can({ role: "author" }, "no:such-capability"), false); // unknown capabilities are never granted
});

// Turns "/courses/:id/lessons/:lessonId" into a concrete path the router would accept.
const sample = path => path.replace(/:\w+/g, "1");

const withBody = method => (method === "GET" ? { method } : { method, body: {} });

/** Every route registered on the admin router, as { method, path }. */
function adminRoutes(app) {
  const routes = [];
  for (const layer of app.locals.adminRouter.stack)
    if (layer.route)
      for (const method of Object.keys(layer.route.methods))
        routes.push({ method: method.toUpperCase(), path: sample(layer.route.path) });
  return routes;
}

test("permissions: every admin route has a listed capability, so none can be forgotten", async () => {
  const s = await start();
  const { createApp } = await import("../app.js");
  const { openDb } = await import("../db.js");
  const app = createApp({ db: openDb(":memory:"), config: {}, ai: { name: "off" } });
  const routes = adminRoutes(app);
  assert.ok(routes.length > 25, `expected plenty of routes, found ${routes.length}`);
  const missing = routes.filter(r => !capabilityFor(r.method, r.path));
  assert.deepEqual(missing, [], "these admin routes have no entry in ADMIN_ROUTES");
  s.close();
});

test("permissions: signed-out visitors and learners are refused on every admin route", async () => {
  const s = await start();
  const { createApp } = await import("../app.js");
  const { openDb } = await import("../db.js");
  const routes = adminRoutes(createApp({ db: openDb(":memory:"), config: {}, ai: { name: "off" } }));
  const signedOut = await s.as(null);
  const learner = await s.as("learner");
  for (const { method, path } of routes) {
    assert.equal(
      (await signedOut(`/api/admin${path}`, withBody(method))).status,
      401,
      `signed out: ${method} ${path}`,
    );
    assert.equal(
      (await learner(`/api/admin${path}`, withBody(method))).status,
      403,
      `learner: ${method} ${path}`,
    );
  }
  s.close();
});

test("permissions: a route nobody listed is refused, even for an admin (fail closed)", async () => {
  const s = await start();
  const admin = await s.as("admin");
  assert.equal((await admin("/api/admin/made-up-route")).status, 403);
  assert.equal((await admin("/api/admin/courses/1/made-up")).status, 403);
  s.close();
});

test("permissions: admin-only areas refuse authors", async () => {
  const s = await start();
  const author = await s.as("author");
  assert.equal((await author("/api/admin/users")).status, 403);
  assert.equal((await author("/api/admin/theme", { method: "PUT", body: { font: "serif" } })).status, 403);
  assert.equal((await author("/api/admin/theme", { method: "DELETE", body: {} })).status, 403);
  s.close();
});

test("permissions: staff capabilities work for authors, and preview does not allow taking part", async () => {
  const s = await start();
  const { author, id } = await quizCourse(s);
  for (const path of [
    `/courses/${id}`,
    `/courses/${id}/enrolments`,
    `/courses/${id}/gradebook`,
    `/courses/${id}/certificates`,
  ])
    assert.equal((await author(`/api/admin${path}`)).status, 200, path);
  assert.equal((await author(`/api/courses/${id}`)).status, 200); // may preview
  assert.equal(
    (await author(`/api/courses/${id}/quiz`, { method: "POST", body: { answers: {} } })).status,
    403,
  ); // may not take part
  s.close();
});
