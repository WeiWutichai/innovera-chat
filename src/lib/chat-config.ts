// Runtime configuration for the chat pipeline's cost and abuse controls.
//
// Every value is env-tunable with a safe default. Invalid values fall back to the
// default and log the VARIABLE NAME ONLY — never its value, so a mistyped secret
// can never reach the logs.

function positiveInt(name: string, fallback: number) {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      JSON.stringify({
        event: "config.invalid_value_ignored",
        variable: name,
        usingDefault: fallback,
      })
    );
    return fallback;
  }

  return parsed;
}

export const chatConfig = {
  // Requests per user per rolling minute. Well above real human pacing (a generation
  // takes tens of seconds and concurrency is capped at 2), so this only catches scripts.
  rateLimitPerMinute: positiveInt("CHAT_RATE_LIMIT_PER_MINUTE", 10),

  // Simultaneous in-flight generations per user.
  maxConcurrentPerUser: positiveInt("CHAT_MAX_CONCURRENT_PER_USER", 2),

  // Total characters of conversation context sent upstream. Deliberately far below the
  // deployed model's 65,536-token ceiling: this bounds prefill cost, latency, KV-cache
  // pressure and multi-user GPU contention, not model capability. Tune from real usage.
  contextCharBudget: positiveInt("CHAT_CONTEXT_CHAR_BUDGET", 20000),

  // Application-side generation timeout. Must stay BELOW NGINX proxy_read_timeout (600s)
  // so the app produces a clean 504 instead of the proxy severing the connection.
  upstreamTimeoutMs: positiveInt("CHAT_UPSTREAM_TIMEOUT_MS", 540000),

  // Upper bound on messages read for context; the char budget usually binds first.
  contextFetchLimit: 21,

  maxMessageLength: 20000,
} as const;

export type UpstreamConfig = {
  baseUrl: string;
  apiKey: string;
};

// Returns null when the AI backend is not configured. Callers fail with a 503 before
// performing any database write, rather than crashing the container at boot — a config
// typo must not take down a running deployment.
export function getUpstreamConfig(): UpstreamConfig | null {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const apiKey = process.env.LITELLM_API_KEY;

  if (!baseUrl || !apiKey) {
    console.error(
      JSON.stringify({
        event: "config.upstream_not_configured",
        missing: [
          !baseUrl ? "LITELLM_BASE_URL" : null,
          !apiKey ? "LITELLM_API_KEY" : null,
        ].filter(Boolean),
      })
    );
    return null;
  }

  // Trailing slashes would produce a double slash in the completions URL.
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}
