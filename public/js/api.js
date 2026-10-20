export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/**
 * Every call is same-origin JSON. A 401 means the session ended, so the app shows sign-in again.
 * @param {string} path the part after /api, such as "/courses"
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<any>} the parsed JSON, or null for an empty response
 */
export async function api(path, { method = "GET", body } = {}) {
  /** @type {RequestInit & { headers: Record<string, string> }} */
  const init = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch("/api" + path, init);
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection and try again.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/login"))
      document.dispatchEvent(new CustomEvent("signed-out"));
    if (res.status === 403 && data?.mustChangePassword)
      document.dispatchEvent(new CustomEvent("must-change-password"));
    throw new ApiError(res.status, data?.error || "Something went wrong. Try again.", data);
  }
  return data;
}
