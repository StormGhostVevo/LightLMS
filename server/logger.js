import { randomBytes } from "node:crypto";

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
// Field names that must never reach a log, whatever a caller passes by mistake.
const SECRET = /pass|secret|token|cookie|authorization|api.?key|session|credential/i;

/** @typedef {{ error: Function, warn: Function, info: Function, debug: Function, child: (fields: object) => Logger }} Logger */

const scrub = (value, depth = 0) => {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (!value || typeof value !== "object" || depth > 2) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => scrub(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? "[redacted]" : scrub(v, depth + 1)]),
  );
};

/**
 * One JSON object per line on stdout, which is what log tools for hosting platforms expect.
 * @param {{ level?: keyof typeof LEVELS, write?: (line: string) => void, fields?: object }} [options]
 * @returns {Logger}
 */
export function createLogger({
  level = "info",
  write = line => process.stdout.write(line + "\n"),
  fields = {},
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (name, msg, extra) => {
    if (LEVELS[name] > threshold) return;
    write(
      JSON.stringify({
        t: new Date().toISOString(),
        level: name,
        msg,
        ...scrub(fields),
        ...(extra ? scrub(extra) : {}),
      }),
    );
  };
  return {
    error: (msg, extra) => emit("error", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    info: (msg, extra) => emit("info", msg, extra),
    debug: (msg, extra) => emit("debug", msg, extra),
    child: more => createLogger({ level, write, fields: { ...fields, ...more } }),
  };
}

// Some addresses contain a secret: a certificate code or an image key lets anyone who has it open that page.
// They are replaced before logging, so the logs can be shared with a support person without sharing those.
/** @type {[RegExp, string][]} */
const HIDE = [
  [/^\/certificate\/[^/]+/, "/certificate/:code"],
  [/^\/media\/[^/]+/, "/media/:key"],
  [/^\/api\/verify\/[^/]+/, "/api/verify/:code"],
];
export const safePath = path => {
  for (const [re, to] of HIDE) if (re.test(path)) return path.replace(re, to);
  return path;
};

/**
 * Gives each request an id (also sent back as X-Request-Id) and a logger that carries it, and logs one line when
 * the response finishes. It logs the method, the address without its query string, the status, how long it took and
 * who (by id, not name or email). It never logs bodies, cookies, headers or IP addresses.
 */
export function requestLogger(/** @type {Logger} */ log) {
  return (req, res, next) => {
    const id = randomBytes(6).toString("hex");
    req.id = id;
    req.log = log.child({ req: id });
    res.set("X-Request-Id", id);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const path = safePath(req.originalUrl.split("?")[0]);
      if (path === "/health") return;
      const quiet = res.statusCode < 400 && !path.startsWith("/api");
      const line = {
        req: id,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
        user: req.user?.id,
      };
      if (res.statusCode >= 500) log.error("request", line);
      else if (quiet) log.debug("request", line);
      else log.info("request", line);
    });
    next();
  };
}
