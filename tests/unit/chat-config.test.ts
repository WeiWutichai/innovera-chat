import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const CONFIG_VARS = [
  "CHAT_RATE_LIMIT_PER_MINUTE",
  "CHAT_MAX_CONCURRENT_PER_USER",
  "CHAT_CONTEXT_CHAR_BUDGET",
  "CHAT_UPSTREAM_TIMEOUT_MS",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of CONFIG_VARS) saved[key] = process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of CONFIG_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

async function loadConfig() {
  vi.resetModules();
  return import("@/lib/chat-config");
}

describe("defaults", () => {
  it("uses the Phase 2 approved defaults when nothing is set", async () => {
    for (const key of CONFIG_VARS) delete process.env[key];

    const { chatConfig } = await loadConfig();

    expect(chatConfig.rateLimitPerMinute).toBe(10);
    expect(chatConfig.maxConcurrentPerUser).toBe(2);
    expect(chatConfig.contextCharBudget).toBe(20_000);
    expect(chatConfig.upstreamTimeoutMs).toBe(540_000);
    expect(chatConfig.contextFetchLimit).toBe(21);
    expect(chatConfig.maxMessageLength).toBe(20_000);
  });

  it("honours valid overrides", async () => {
    process.env.CHAT_RATE_LIMIT_PER_MINUTE = "25";
    process.env.CHAT_CONTEXT_CHAR_BUDGET = "8000";

    const { chatConfig } = await loadConfig();

    expect(chatConfig.rateLimitPerMinute).toBe(25);
    expect(chatConfig.contextCharBudget).toBe(8000);
  });
});

describe("invalid values", () => {
  it.each([
    ["not-a-number", "nonsense"],
    ["0", "zero"],
    ["-5", "negative"],
    ["1.5", "non-integer"],
    ["", "empty string"],
  ])("falls back to the default for %s (%s)", async (value) => {
    process.env.CHAT_RATE_LIMIT_PER_MINUTE = value;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { chatConfig } = await loadConfig();

    expect(chatConfig.rateLimitPerMinute).toBe(10);
  });

  it("warns with the variable NAME and never the offending value", async () => {
    // A distinctive value so the assertion cannot be satisfied by coincidence — a
    // short value like "0" appears inside the legitimate `"usingDefault":10` output.
    process.env.CHAT_RATE_LIMIT_PER_MINUTE = "wildly-invalid-sentinel";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { chatConfig } = await loadConfig();

    expect(chatConfig.rateLimitPerMinute).toBe(10);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("CHAT_RATE_LIMIT_PER_MINUTE");
    expect(logged).not.toContain("wildly-invalid-sentinel");
  });
});

describe("upstream configuration", () => {
  it("returns null and names the missing variables when unset", async () => {
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { getUpstreamConfig } = await loadConfig();

    expect(getUpstreamConfig()).toBeNull();
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("LITELLM_BASE_URL");
    expect(logged).toContain("LITELLM_API_KEY");
  });

  it("strips trailing slashes so the completions URL never doubles up", async () => {
    process.env.LITELLM_BASE_URL = "http://127.0.0.1:4010///";
    process.env.LITELLM_API_KEY = "k";

    const { getUpstreamConfig } = await loadConfig();

    expect(getUpstreamConfig()?.baseUrl).toBe("http://127.0.0.1:4010");
  });

  it("never writes the API key to the log", async () => {
    delete process.env.LITELLM_BASE_URL;
    process.env.LITELLM_API_KEY = "super-secret-value";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { getUpstreamConfig } = await loadConfig();
    getUpstreamConfig();

    expect(error.mock.calls.flat().join(" ")).not.toContain("super-secret-value");
  });
});
