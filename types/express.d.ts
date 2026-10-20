// What the server adds to Express's request: the signed-in person and their session, set by sessionMiddleware.
declare namespace Express {
  interface Request {
    user: {
      id: number;
      email: string;
      name: string;
      role: "admin" | "author" | "learner";
      must_change_password: number;
      expires_at?: string;
    } | null;
    sid?: string;
    /** A short random id for this request, also sent back as X-Request-Id. */
    id: string;
    /** A logger that already carries the request id. */
    log: import("../server/logger.js").Logger;
  }
}
