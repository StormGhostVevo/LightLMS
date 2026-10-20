const env = process.env;
const prod = env.NODE_ENV === "production";

export function loadConfig(overrides = {}) {
  const c = {
    prod,
    port: Number(env.PORT || 3000),
    orgName: env.ORG_NAME || "lightlms",              // shown on certificates
    timeZone: env.TIMEZONE || "Australia/Sydney",     // dates on certificates
    dbPath: env.DATABASE_PATH || "data/lightlms.sqlite",
    ai: {
      provider: env.AI_PROVIDER || (prod ? "off" : "stub"),
      apiKey: env.ANTHROPIC_API_KEY || "",
      model: env.AI_MODEL || "claude-sonnet-5-5",
    },
    ...overrides,
  };
  if (c.ai.provider === "anthropic" && !c.ai.apiKey) throw new Error("AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
  return c;
}
