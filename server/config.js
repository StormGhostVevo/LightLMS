import { z } from "zod";

const validZone = zone => {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

// Every setting is checked once at start-up, so a typo stops the server with a clear message instead of
// causing odd behaviour later. Empty values count as "not set".
const schema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("data/lightlms.sqlite"),
  ORG_NAME: z.string().max(60).default("lightlms"),
  TIMEZONE: z
    .string()
    .refine(validZone, "must be a time zone such as Australia/Sydney")
    .default("Australia/Sydney"),
  AI_PROVIDER: z.enum(["stub", "anthropic", "off"]).optional(),
  ANTHROPIC_API_KEY: z.string().default(""),
  AI_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  // How many proxies sit in front of the server (Railway and most hosts: 1). It decides which address counts as the
  // visitor's, so rate limits apply per person and not to everyone behind the proxy at once.
  LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).optional(),
});

/**
 * @param {Record<string, any>} [overrides] values that replace the environment's (used by tests)
 * @param {Record<string, string | undefined>} [env]
 */
export function loadConfig(overrides = {}, env = process.env) {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === "production";
  const provider = e.AI_PROVIDER ?? (prod ? "off" : "stub");
  if (provider === "anthropic" && !e.ANTHROPIC_API_KEY)
    throw new Error("Invalid configuration:\n  AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
  return {
    prod,
    port: e.PORT,
    orgName: e.ORG_NAME,
    timeZone: e.TIMEZONE,
    dbPath: e.DATABASE_PATH,
    trustProxy: e.TRUST_PROXY ?? (prod ? 1 : 0),
    logLevel: e.LOG_LEVEL,
    ai: { provider, apiKey: e.ANTHROPIC_API_KEY, model: e.AI_MODEL },
    ...overrides,
  };
}
