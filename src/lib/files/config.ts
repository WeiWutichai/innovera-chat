/**
 * Bounded configuration for file storage.
 *
 * Every value is env-tunable, but each is clamped to an absolute ceiling that the
 * environment cannot raise. An operator typo (FILE_MAX_SIZE_MB=25000, or a stray
 * "unlimited") must degrade to something safe rather than create an unbounded upload
 * path on a single-replica host with a shared disk.
 *
 * Invalid values are ignored in favour of the default and logged by NAME only, matching
 * the convention in chat-config.ts — a mistyped secret can never reach the logs.
 */

const MB = 1024 * 1024;

/** Absolute ceilings. Not configurable by design. */
export const CEILINGS = {
  maxSizeMb: 100,
  maxPerUpload: 50,
  // The aggregate cap is the one that actually bounds peak memory: uploads are buffered
  // to compare declared size against real bytes, so this is the worst case a single
  // request can put in the heap of a single-replica container.
  maxBatchMb: 200,
  quotaMb: 51_200, // 50 GB
} as const;

export const DEFAULTS = {
  maxSizeMb: 25,
  maxPerUpload: 10,
  maxBatchMb: 50,
  quotaMb: 2048,
} as const;

function boundedInt(name: string, fallback: number, ceiling: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === "") return fallback;

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

  if (parsed > ceiling) {
    // Clamped, not rejected: the operator's intent (a larger limit) is honoured as far
    // as it is safe to do so, and the clamp is recorded so it is discoverable.
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

/**
 * Read at CALL time, never at module load, so tests that set and unset variables cannot
 * become order-dependent — the same rule build-config.ts follows.
 */
export function fileConfig() {
  const maxSizeMb = boundedInt("FILE_MAX_SIZE_MB", DEFAULTS.maxSizeMb, CEILINGS.maxSizeMb);
  const maxPerUpload = boundedInt("FILE_MAX_PER_UPLOAD", DEFAULTS.maxPerUpload, CEILINGS.maxPerUpload);
  const maxBatchMb = boundedInt("FILE_MAX_BATCH_MB", DEFAULTS.maxBatchMb, CEILINGS.maxBatchMb);
  const quotaMb = boundedInt("FILE_STORAGE_QUOTA_MB", DEFAULTS.quotaMb, CEILINGS.quotaMb);

  return {
    maxSizeMb,
    maxSizeBytes: maxSizeMb * MB,
    maxPerUpload,
    maxBatchMb,
    maxBatchBytes: maxBatchMb * MB,
    quotaMb,
    quotaBytes: quotaMb * MB,
    /** Uploads per user per rolling minute. Separate from the chat limiter. */
    uploadsPerMinute: boundedInt("FILE_UPLOADS_PER_MINUTE", 20, 120),
  };
}

/**
 * Storage root. Absolute path required: a relative root would resolve against the
 * process working directory, which differs between `next dev`, the standalone server
 * and the test harness.
 */
export function storageRoot(): string {
  return process.env.FILE_STORAGE_ROOT || "/data/files";
}
