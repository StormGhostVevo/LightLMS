import { bad } from "./http.js";

/**
 * What each role may do, written as capabilities. Routes ask "may this person do X?", never "is this person an admin?",
 * so changing who can do what (or adding a per-course role later) means changing this file and nothing else.
 *
 * Learners need no capability: they sign in, and see a course only if they are enrolled in it.
 */
/** @type {Record<string, { roles: string[], does: string }>} */
export const GRANTS = {
  "course:author": {
    roles: ["author", "admin"],
    does: "Create, edit, publish and delete courses, lessons, questions and images; use the AI",
  },
  "course:preview": { roles: ["author", "admin"], does: "Read any published course without being enrolled" },
  "enrolment:manage": { roles: ["author", "admin"], does: "Enrol people in a course and remove them" },
  "results:view": { roles: ["author", "admin"], does: "See the gradebook and anyone's quiz answers" },
  "certificate:manage": { roles: ["author", "admin"], does: "Correct, revoke and restore certificates" },
  "user:manage": { roles: ["admin"], does: "Create users, change roles, deactivate, reset passwords" },
  "theme:manage": { roles: ["admin"], does: "Change the site's appearance" },
  "backup:manage": { roles: ["admin"], does: "See, make and download backups" },
  "audit:view": { roles: ["admin"], does: "Read the audit log" },
};

/**
 * @param {{ role: string } | null | undefined} user
 * @param {string} capability a key of GRANTS
 * @param {{ courseId?: number }} [_resource] unused today; here so a per-course role can be added without touching callers
 */
export function can(user, capability, _resource) {
  return !!user && !!GRANTS[capability]?.roles.includes(user.role);
}

/** Middleware: 401 if signed out, 403 if signed in without the capability. */
export const requireCapability = capability => (req, res, next) =>
  !req.user
    ? bad(res, "Please sign in", 401)
    : can(req.user, capability)
      ? next()
      : bad(res, "You don't have access to that", 403);

// Every route under /api/admin must be listed here. A route with no entry is refused, so forgetting is safe, not open.
// Paths are relative to /api/admin. `*` matches any method.
/** @type {[method: string, path: RegExp, capability: string][]} */
export const ADMIN_ROUTES = [
  ["*", /^\/ai\/(status|draft-course)$/, "course:author"],
  ["*", /^\/courses$/, "course:author"],
  ["*", /^\/courses\/\d+$/, "course:author"],
  ["*", /^\/courses\/\d+\/(publish|unpublish|image|images|quiz\/generate)$/, "course:author"],
  ["*", /^\/courses\/\d+\/(lessons|questions)(\/order)?$/, "course:author"],
  ["*", /^\/(lessons|questions)\/\d+$/, "course:author"],
  ["*", /^\/courses\/\d+\/enrolments(\/\d+)?$/, "enrolment:manage"],
  ["*", /^\/courses\/\d+\/(gradebook|gradebook\.csv)$/, "results:view"],
  ["*", /^\/courses\/\d+\/users\/\d+\/attempts$/, "results:view"],
  ["*", /^\/courses\/\d+\/certificates$/, "certificate:manage"],
  ["*", /^\/certificates\/\d+$/, "certificate:manage"],
  ["GET", /^\/audit$/, "audit:view"],
  ["*", /^\/backups(\/[^/]+\/download)?$/, "backup:manage"],
];

/** The capability a request to /api/admin needs, or undefined if the route isn't listed. */
export const capabilityFor = (method, path) =>
  ADMIN_ROUTES.find(([m, re]) => (m === "*" || m === method) && re.test(path))?.[2];

/** Guard for the whole /api/admin router. Unlisted routes are refused. */
export const adminGuard = (req, res, next) => {
  if (!req.user) return bad(res, "Please sign in", 401);
  const needed = capabilityFor(req.method, req.path);
  if (!needed) {
    (req.log ?? console).error(
      `No capability is listed for ${req.method} /api/admin${req.path}; refusing. Add it to ADMIN_ROUTES.`,
    );
    return bad(res, "You don't have access to that", 403);
  }
  return can(req.user, needed) ? next() : bad(res, "You don't have access to that", 403);
};
