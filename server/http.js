// Small helpers shared by every route file.

/** The current time as an ISO string, which is how every timestamp in the database is written. */
export const now = () => new Date().toISOString();

/** Sends `{ error: message }` with a status code. The message is meant to be shown to a person as it is. */
export const bad = (res, message, status = 400) => res.status(status).json({ error: message });

/**
 * Throw this from a service or a route to stop with a plain-language error; the error handler turns it into a response.
 * (Express 5 passes errors thrown inside async handlers to the error handler as well.)
 */
export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The last middleware: turns HttpError and body-parser problems into JSON, and hides anything unexpected. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return bad(res, err.message, err.status);
  if (err.type === "entity.too.large") return bad(res, "That request is too large", 413);
  if (err.type === "entity.parse.failed") return bad(res, "Invalid JSON");
  console.error(err);
  return bad(res, "Something went wrong", 500);
}
