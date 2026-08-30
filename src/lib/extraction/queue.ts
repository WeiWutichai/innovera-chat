import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/files/storage/factory";
import { runExtraction } from "@/lib/extraction/registry";
import { LIMITS } from "@/lib/extraction/limits";
import { extractionConfig } from "@/lib/extraction/config";
import type { ExtractionStatus } from "@/lib/extraction/types";
import { logError, logInfo, logWarn } from "@/lib/log";

/**
 * Extraction job runner.
 *
 * ============================== WHY NO QUEUE SERVICE ==============================
 * The deployment is a single replica with a PostgreSQL it already depends on. Adding
 * Redis or a broker would introduce a second stateful service, a second failure mode,
 * a second backup obligation and a second thing to secure — to coordinate work that at
 * present amounts to a handful of files per day. PostgreSQL's `FOR UPDATE SKIP LOCKED`
 * is the standard queue primitive and is already available.
 *
 * The service boundary is `claimNext` / `completeJob`, so moving to a dedicated worker
 * later means running this loop in another process, not rewriting the callers.
 *
 * ================================ CONCURRENCY ====================================
 * Claiming is a single atomic statement:
 *
 *   UPDATE "File" SET status = PROCESSING, lease = now() + interval
 *   WHERE id = (
 *     SELECT id FROM "File"
 *     WHERE status = 'PENDING' OR (status = 'PROCESSING' AND lease < now())
 *     ORDER BY "createdAt" LIMIT 1
 *     FOR UPDATE SKIP LOCKED          -- two workers never see the same row
 *   )
 *   RETURNING ...
 *
 * If two processes claim concurrently, `SKIP LOCKED` makes the second skip the row the
 * first has locked and take the next one instead — no blocking, no duplicate work, and
 * no possibility of both processing the same file.
 *
 * ================================== RECOVERY =====================================
 * A crash mid-extraction leaves a row in PROCESSING. The LEASE is what makes that
 * recoverable: the same claim query treats `PROCESSING AND lease < now()` as available,
 * so an abandoned row is picked up by the next sweep with no cron, no startup hook and
 * no manual intervention. Age alone is never the signal — a long extraction is not an
 * abandoned one — which is why the lease is refreshed by the holder rather than inferred.
 *
 * `extractAttempts` bounds retries so a file that reliably crashes the parser fails
 * permanently instead of cycling forever.
 *
 * ========================= LOCAL CONCURRENCY (RUNNER POOL) =======================
 * The database lease above is the CROSS-PROCESS correctness mechanism and stays that
 * way. It is not, however, a resource bound: nothing in `SKIP LOCKED` stops one process
 * from claiming many rows at once and running many parsers simultaneously. Twenty
 * concurrent uploads would otherwise mean twenty concurrent parsers in one container.
 *
 * So this module also keeps a PROCESS-LOCAL runner pool, capped at
 * `EXTRACTION_MAX_CONCURRENT` (default 2, hard ceiling 4).
 *
 * The pool is deliberately a fixed set of runners rather than a semaphore with a queue
 * of waiters. A semaphore would make each of twenty triggers park a pending promise,
 * so request volume would still translate into unbounded promise creation even though
 * parser concurrency was bounded. Here, `scheduleSweep()` TOPS UP the pool instead: if
 * the pool is already full the call does nothing at all. Twenty simultaneous triggers
 * therefore create at most `maxConcurrent` promises and eighteen no-ops.
 *
 * A runner holds its slot for its whole life and releases it in a `finally`, so the slot
 * is returned after success, after failure and after a parser timeout alike.
 *
 * ============================== FENCING THE FINAL WRITE ==========================
 * `claimNext` increments `extractAttempts` and returns the new value, which makes that
 * number a FENCING TOKEN for the claim. `completeJob` writes only where the row is still
 * PROCESSING *and* still carries the attempt number the worker claimed under.
 *
 * That is what makes a late parser completion harmless. If a worker stalls past its
 * lease and another process re-claims the row, the re-claim bumps the attempt counter,
 * and the stalled worker's eventual write matches zero rows instead of overwriting a
 * terminal state that somebody else already established.
 * =================================================================================
 */

/** How long a claim is valid. Comfortably longer than the parser timeout. */
const LEASE_MS = LIMITS.timeoutMs * 3;

/** After this many attempts a file is failed permanently rather than retried. */
const MAX_ATTEMPTS = 3;

/** Upper bound on files processed by one sweep, so a request-triggered run is bounded. */
const SWEEP_BATCH = 5;

type ClaimedJob = {
  id: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  extractAttempts: number;
};

/**
 * Atomically claims one job, or returns null when there is nothing to do.
 *
 * Written as raw SQL because Prisma has no way to express `FOR UPDATE SKIP LOCKED`, and
 * the whole correctness argument depends on the claim being one statement.
 */
export async function claimNext(now: Date = new Date()): Promise<ClaimedJob | null> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);

  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "File" SET
      "extractStatus"     = 'PROCESSING',
      -- Same conversion on the way in, so what is written matches what is compared.
      "extractLeaseUntil" = (${leaseUntil} AT TIME ZONE 'UTC'),
      "extractAttempts"   = "extractAttempts" + 1
    WHERE id = (
      SELECT id FROM "File"
      WHERE "extractStatus" = 'PENDING'
         OR (
           "extractStatus" = 'PROCESSING'
           -- AT TIME ZONE 'UTC' is load-bearing, not decoration. extractLeaseUntil is
           -- TIMESTAMP(3) WITHOUT TIME ZONE and Prisma stores the UTC wall-clock in it,
           -- but a bound Date parameter arrives as timestamptz. Comparing the two
           -- directly makes PostgreSQL apply the SERVER's timezone, so on a UTC+7 host
           -- every live lease reads as already expired — and two workers would then
           -- claim the same row. Converting the parameter to a UTC-naive timestamp puts
           -- both sides in the frame the column was written in.
           AND "extractLeaseUntil" < (${now} AT TIME ZONE 'UTC')
         )
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "storageKey", filename, "mimeType", "extractAttempts"
  `;

  return rows[0] ?? null;
}

/**
 * Writes a terminal state and clears the lease.
 *
 * Fenced on (id, PROCESSING, expectedAttempt) — see FENCING THE FINAL WRITE above.
 * Returns true when this worker's write was the one that landed.
 */
async function completeJob(
  fileId: string,
  expectedAttempt: number,
  status: ExtractionStatus | "FAILED",
  fields: {
    reason?: string;
    text?: string;
    chars?: number;
    truncated?: boolean;
    units?: unknown;
    metadata?: unknown;
  }
): Promise<boolean> {
  const dbStatus = status.toUpperCase() as
    | "EXTRACTED"
    | "PARTIAL"
    | "UNSUPPORTED"
    | "FAILED";

  // updateMany, not update: a fenced-out write must be a no-op, not a thrown P2025.
  const { count } = await prisma.file.updateMany({
    where: {
      id: fileId,
      extractStatus: "PROCESSING",
      extractAttempts: expectedAttempt,
    },
    data: {
      extractStatus: dbStatus,
      extractReason: fields.reason ?? null,
      extractedText: fields.text ?? null,
      extractedChars: fields.chars ?? null,
      extractTruncated: fields.truncated ?? false,
      extractUnits: (fields.units ?? undefined) as never,
      extractMetadata: (fields.metadata ?? undefined) as never,
      extractedAt: new Date(),
      extractLeaseUntil: null,
    },
  });

  return count === 1;
}

/**
 * Runs one claimed job to a terminal state. Returns false when nothing was claimed.
 *
 * This is the inner unit of work and does NOT take a concurrency slot itself. Slots are
 * held by runners (see `sweep` and `scheduleSweep`), which are the only production entry
 * points; a runner holds one slot across every job in its batch.
 */
export async function processNext(): Promise<boolean> {
  const job = await claimNext();
  if (!job) return false;

  const startedAt = Date.now();

  logInfo("file.extract_started", {
    fileId: job.id,
    mimeType: job.mimeType,
    attempt: job.extractAttempts,
  });

  // A file that has already failed repeatedly is not retried indefinitely.
  if (job.extractAttempts > MAX_ATTEMPTS) {
    await completeJob(job.id, job.extractAttempts, "FAILED", {
      reason: "extraction did not succeed after repeated attempts",
    });

    logWarn("file.extract_failed", {
      fileId: job.id,
      mimeType: job.mimeType,
      reason: "max_attempts",
      durationMs: Date.now() - startedAt,
    });

    return true;
  }

  try {
    const stream = await getStorage().get(job.storageKey);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const buffer = Buffer.concat(chunks);

    const result = await runExtraction({
      buffer,
      filename: job.filename,
      mimeType: job.mimeType,
    });

    const landed = await completeJob(job.id, job.extractAttempts, result.status, {
      reason: result.reason,
      text: result.text,
      chars: result.chars,
      truncated: result.truncated,
      units: result.units,
      metadata: result.metadata,
    });

    // Scalars only. Never the extracted text, the filename or any file content.
    logInfo("file.extract_completed", {
      fileId: job.id,
      mimeType: job.mimeType,
      status: result.status,
      chars: result.chars,
      truncated: result.truncated,
      fenced: !landed,
      durationMs: Date.now() - startedAt,
    });
  } catch {
    // The lease is cleared here rather than left to expire: this is a known failure, so
    // the row should reach a terminal state now, not after a lease timeout.
    await completeJob(job.id, job.extractAttempts, "FAILED", {
      reason: "the file could not be read for extraction",
    }).catch(() => {
      logError("file.extract_finalise_failed", { fileId: job.id });
    });

    logWarn("file.extract_failed", {
      fileId: job.id,
      mimeType: job.mimeType,
      reason: "read_or_parse_error",
      durationMs: Date.now() - startedAt,
    });
  }

  return true;
}

/* ------------------------------- runner pool -------------------------------- */

/**
 * Slots in use, process-wide. Mutated only synchronously (increment before the runner's
 * first await, decrement in a `finally`), so on a single-threaded event loop there is no
 * window in which two callers can both observe a free slot and both take it.
 */
let activeRunners = 0;

/** Processes up to `limit` jobs sequentially. Assumes the caller holds a slot. */
async function runBatch(limit: number): Promise<number> {
  let processed = 0;

  for (let i = 0; i < limit; i++) {
    if (!(await processNext())) break;
    processed++;
  }

  return processed;
}

/**
 * Awaitable bounded sweep.
 *
 * Takes one slot. Returns 0 immediately when the pool is already full rather than
 * queueing — a caller that cannot run now must not park a promise waiting to.
 *
 * Crucially it takes the slot BEFORE claiming: claiming a row and then discovering
 * there is no capacity to run it would burn an attempt and strand the row in PROCESSING
 * until its lease expired.
 */
export async function sweep(limit: number = SWEEP_BATCH): Promise<number> {
  if (activeRunners >= extractionConfig().maxConcurrent) return 0;

  activeRunners++;

  try {
    return await runBatch(limit);
  } finally {
    activeRunners--;
  }
}

/**
 * Fire-and-forget trigger.
 *
 * Deliberately not awaited by the caller: extraction must never delay the upload or list
 * response, and no request ever waits for the queue to drain. Errors are swallowed
 * because the work is recoverable by definition — the row stays PENDING (or its lease
 * expires) and the next trigger picks it up.
 *
 * Tops the pool up to its cap. When the pool is already full this is a pure no-op, which
 * is what keeps N simultaneous requests from creating N pending promises.
 */
export function scheduleSweep(): void {
  const max = extractionConfig().maxConcurrent;

  while (activeRunners < max) {
    activeRunners++;

    void runBatch(SWEEP_BATCH)
      .catch(() => {
        logError("file.sweep_failed", {});
      })
      .finally(() => {
        activeRunners--;
      });
  }
}

export const __testing = {
  LEASE_MS,
  MAX_ATTEMPTS,
  SWEEP_BATCH,
  completeJob,
  activeRunners: () => activeRunners,
  resetPool: () => {
    activeRunners = 0;
  },
};
