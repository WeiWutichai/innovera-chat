/**
 * Bounded configuration for extraction concurrency.
 *
 * Follows the same rule as files/config.ts: env-tunable, clamped to a ceiling the
 * environment cannot raise, read at CALL time so tests that set and unset variables
 * cannot become order-dependent, and logged by NAME only.
 */

/**
 * Absolute ceiling on simultaneous parsers in one process. Not configurable by design.
 *
 * The number is memory arithmetic, not taste. A single job can hold the file buffer
 * (up to the 100 MB upload ceiling) plus inflated OOXML content (up to LIMITS.zip
 * .maxTotalBytes, 256 MB) at the same time. Four concurrent worst-case jobs is already
 * ~1.4 GB of transient heap on a single-replica container that is also serving chat.
 * Anything above this stops being a throughput setting and becomes an OOM.
 */
export const MAX_CONCURRENT_CEILING = 4;

/**
 * Two, not one: one slow file (a 500-page PDF) would otherwise stall every other
 * pending file behind it for the full parse. Two, not four: extraction is background
 * work that must never compete with chat for the same container's CPU.
 */
export const DEFAULT_MAX_CONCURRENT = 2;

function boundedInt(name: string, fallback: number, ceiling: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);

  // Rejects 0, negatives, fractions, NaN and "unlimited" alike. A limiter that can be
  // switched off by a typo is not a limiter.
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      JSON.stringify({
        event: "config.invalid_value_ignored",
        variable: name,
        usingDefault: fallback,
      })
    );
    return fallback;
  }

  if (parsed > ceiling) {
    console.warn(
      JSON.stringify({
        event: "config.value_clamped_to_ceiling",
        variable: name,
        requested: parsed,
        ceiling,
      })
    );
    return ceiling;
  }

  return parsed;
}

export function extractionConfig() {
  return {
    maxConcurrent: boundedInt(
      "EXTRACTION_MAX_CONCURRENT",
      DEFAULT_MAX_CONCURRENT,
      MAX_CONCURRENT_CEILING
    ),
  };
}
