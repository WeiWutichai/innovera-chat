import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Local extraction concurrency.
 *
 * The database lease proves two PROCESSES never run the same file. It says nothing about
 * how many parsers ONE process may run at once — twenty concurrent uploads could
 * otherwise mean twenty concurrent parsers in a single container. These tests pin the
 * process-local bound.
 *
 * Every test drives a controllable fake parser rather than a real one. Real parsers on
 * small fixtures finish in microseconds, so a test built on them would observe a peak
 * concurrency of 1 whether the limiter existed or not — it would pass with the
 * protection removed, which proves nothing. The gate below holds every parser open until
 * the test releases it, which makes the overlap real and the measurement meaningful.
 */

const gate = {
  active: 0,
  peak: 0,
  started: 0,
  release: () => {},
  blocked: Promise.resolve(),
  /** When set, the fake parser throws instead of returning. */
  throws: false,
  /** When set, the fake parser returns the shape runExtraction gives on timeout. */
  timesOut: false,
};

function resetGate() {
  gate.active = 0;
  gate.peak = 0;
  gate.started = 0;
  gate.throws = false;
  gate.timesOut = false;
  gate.blocked = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
}

vi.mock("@/lib/extraction/registry", () => ({
  runExtraction: async () => {
    gate.started++;
    gate.active++;
    gate.peak = Math.max(gate.peak, gate.active);

    try {
      await gate.blocked;

      if (gate.throws) throw new Error("parser exploded");

      if (gate.timesOut) {
        return {
          status: "failed" as const,
          reason: "extraction exceeded the 30s time limit",
          text: "",
          chars: 0,
          truncated: false,
          metadata: {},
        };
      }

      return {
        status: "extracted" as const,
        text: "ok",
        chars: 2,
        truncated: false,
        metadata: {},
      };
    } finally {
      gate.active--;
    }
  },
}));

import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { __resetStorage } from "@/lib/files/storage/factory";
import { sweep, scheduleSweep, claimNext, __testing } from "@/lib/extraction/queue";
import { DEFAULT_MAX_CONCURRENT, MAX_CONCURRENT_CEILING } from "@/lib/extraction/config";

let root: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  resetGate();
  __testing.resetPool();

  root = mkdtempSync(path.join(os.tmpdir(), "m2-conc-"));
  process.env.FILE_STORAGE_ROOT = root;
  __resetStorage();

  const user = await seedUser({ clerkUserId: "ck_c", email: "c@test.local" });
  userId = user.id;
});

afterEach(async () => {
  // Release anything still parked so a failing assertion cannot leave runners wedged
  // and poison the next test in this sequential project.
  gate.release();
  await waitForIdle();

  rmSync(root, { recursive: true, force: true });
  delete process.env.FILE_STORAGE_ROOT;
  delete process.env.EXTRACTION_MAX_CONCURRENT;
  __resetStorage();
  __testing.resetPool();
});

/** `offset` keeps ids unique when a test seeds more than once. */
async function seedFiles(n: number, offset = 0) {
  mkdirSync(path.join(root, userId), { recursive: true });

  for (let i = offset; i < offset + n; i++) {
    const fileId = `c${String(i).padStart(31, "0")}`;
    const storageKey = `${userId}/${fileId}`;
    writeFileSync(path.join(root, storageKey), Buffer.from(`content ${i}`));

    await prisma.file.create({
      data: {
        id: fileId,
        userId,
        storageKey,
        filename: `f${i}.txt`,
        mimeType: "text/plain",
        sizeBytes: 9,
        checksum: "x".repeat(64),
        extractStatus: "PENDING",
      },
    });
  }
}

/** Waits until every runner has released its slot. */
async function waitForIdle(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (__testing.activeRunners() > 0) {
    if (Date.now() > deadline) throw new Error("runners did not drain");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Lets queued microtasks and the runner loop make progress. */
async function settle(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("20 simultaneous triggering requests", () => {
  it("does not create 20 concurrently executing parsers", async () => {
    await seedFiles(20);

    // Exactly the shape of 20 uploads landing at once.
    for (let i = 0; i < 20; i++) scheduleSweep();

    await settle();

    // The headline requirement.
    expect(gate.peak).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
    expect(gate.active).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);

    gate.release();
    await waitForIdle();

    expect(gate.peak).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
  });

  it("creates at most maxConcurrent runners, so triggers do not pile up promises", async () => {
    await seedFiles(20);

    for (let i = 0; i < 20; i++) scheduleSweep();

    // 20 triggers, 2 runners: the other 18 calls were pure no-ops rather than 18
    // promises parked on a semaphore.
    expect(__testing.activeRunners()).toBe(DEFAULT_MAX_CONCURRENT);

    gate.release();
    await waitForIdle();
  });

  it("returns from the trigger without waiting for the queue to drain", async () => {
    await seedFiles(20);

    // Nothing is released, so no parser can finish. If scheduling awaited the queue,
    // this call could not return at all.
    const before = Date.now();
    scheduleSweep();
    const elapsed = Date.now() - before;

    expect(elapsed).toBeLessThan(50);
    expect(gate.started).toBe(0); // not even started synchronously

    // And the files are still unprocessed while the caller has already moved on.
    expect(await prisma.file.count({ where: { extractStatus: "EXTRACTED" } })).toBe(0);

    gate.release();
    await waitForIdle();
  });

  it("never exceeds the limit even when triggers keep arriving during processing", async () => {
    await seedFiles(20);

    for (let i = 0; i < 20; i++) scheduleSweep();
    await settle(5);

    // A second wave while the first is mid-flight.
    for (let i = 0; i < 20; i++) scheduleSweep();
    await settle(5);

    expect(gate.peak).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);

    gate.release();
    await waitForIdle();

    expect(gate.peak).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
  });
});

describe("the limiter is honoured, not decorative", () => {
  it("respects EXTRACTION_MAX_CONCURRENT=1", async () => {
    process.env.EXTRACTION_MAX_CONCURRENT = "1";
    await seedFiles(10);

    for (let i = 0; i < 10; i++) scheduleSweep();
    await settle();

    expect(gate.peak).toBe(1);
    expect(__testing.activeRunners()).toBe(1);

    gate.release();
    await waitForIdle();
  });

  it("allows the configured limit to be raised within the ceiling", async () => {
    process.env.EXTRACTION_MAX_CONCURRENT = "3";
    await seedFiles(10);

    for (let i = 0; i < 10; i++) scheduleSweep();
    await settle();

    // Proves the peak tracks configuration rather than being accidentally capped by
    // something else, which is what makes the =1 and default cases meaningful.
    expect(gate.peak).toBe(3);

    gate.release();
    await waitForIdle();
  });

  it("does not claim database rows it has no capacity to run", async () => {
    process.env.EXTRACTION_MAX_CONCURRENT = "1";
    await seedFiles(10);

    scheduleSweep();
    await settle(5);

    // The slot is taken BEFORE the claim, so a saturated pool leaves rows PENDING
    // instead of claiming them, burning an attempt and stranding them in PROCESSING.
    const processing = await prisma.file.count({ where: { extractStatus: "PROCESSING" } });
    expect(processing).toBe(1);

    gate.release();
    await waitForIdle();
  });

  it("refuses an awaitable sweep when the pool is already full", async () => {
    process.env.EXTRACTION_MAX_CONCURRENT = "1";
    await seedFiles(5);

    scheduleSweep();
    await settle(3);

    // Returns immediately with 0 rather than queueing behind the running runner.
    const started = Date.now();
    const processed = await sweep();

    expect(processed).toBe(0);
    expect(Date.now() - started).toBeLessThan(50);

    gate.release();
    await waitForIdle();
  });
});

describe("slots are always released", () => {
  it("releases the slot after success", async () => {
    await seedFiles(2);

    scheduleSweep();
    gate.release();
    await waitForIdle();

    expect(__testing.activeRunners()).toBe(0);
  });

  it("releases the slot after a parser failure", async () => {
    await seedFiles(2);
    gate.throws = true;

    scheduleSweep();
    gate.release();
    await waitForIdle();

    expect(__testing.activeRunners()).toBe(0);

    const failed = await prisma.file.count({ where: { extractStatus: "FAILED" } });
    expect(failed).toBeGreaterThan(0);
  });

  it("releases the slot after a timeout", async () => {
    await seedFiles(2);
    gate.timesOut = true;

    scheduleSweep();
    gate.release();
    await waitForIdle();

    expect(__testing.activeRunners()).toBe(0);
  });

  it("lets a subsequent extraction proceed after a timeout", async () => {
    await seedFiles(1);
    gate.timesOut = true;

    scheduleSweep();
    gate.release();
    await waitForIdle();

    // A timed-out job must not permanently retain its slot.
    resetGate();
    await seedFiles(1, 1);

    scheduleSweep();
    gate.release();
    await waitForIdle();

    expect(gate.started).toBeGreaterThan(0);
  });

  it("releases every slot even when the pool is saturated and all jobs fail", async () => {
    await seedFiles(10);
    gate.throws = true;

    for (let i = 0; i < 20; i++) scheduleSweep();
    gate.release();
    await waitForIdle();

    expect(__testing.activeRunners()).toBe(0);
  });
});

describe("the database lease remains the cross-process mechanism", () => {
  it("never lets concurrent sweeps claim the same file", async () => {
    process.env.EXTRACTION_MAX_CONCURRENT = String(MAX_CONCURRENT_CEILING);
    await seedFiles(4);

    for (let i = 0; i < 10; i++) scheduleSweep();
    gate.release();
    await waitForIdle();

    // Each file processed exactly once: attempts never exceed 1.
    const rows = await prisma.file.findMany({ select: { extractAttempts: true } });
    expect(rows.every((r) => r.extractAttempts === 1)).toBe(true);
  });

  it("still recovers a stale PROCESSING row after the pool has gone idle", async () => {
    mkdirSync(path.join(root, userId), { recursive: true });
    const storageKey = `${userId}/${"s".repeat(32)}`;
    writeFileSync(path.join(root, storageKey), Buffer.from("stranded"));

    await prisma.file.create({
      data: {
        id: "s".repeat(32),
        userId,
        storageKey,
        filename: "stranded.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
        checksum: "x".repeat(64),
        extractStatus: "PROCESSING",
        extractLeaseUntil: new Date(Date.now() - 60_000),
      },
    });

    gate.release();
    scheduleSweep();
    await waitForIdle();

    const after = await prisma.file.findUniqueOrThrow({ where: { id: "s".repeat(32) } });
    expect(after.extractStatus).toBe("EXTRACTED");
    expect(after.extractLeaseUntil).toBeNull();
  });

  it("keeps the local limiter independent of the lease", async () => {
    // The limiter bounds resources; the lease bounds correctness. Removing the limiter
    // must not make two claims of one row possible, and vice versa.
    await seedFiles(1);

    const [a, b] = await Promise.all([claimNext(), claimNext()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("late completion cannot change a terminal state", () => {
  it("fences a stale worker out by its claim attempt number", async () => {
    await seedFiles(1);
    const id = `c${"0".repeat(31)}`;

    // Worker A claims (attempt 1) and then stalls past its lease.
    const first = await claimNext();
    expect(first?.extractAttempts).toBe(1);

    await prisma.file.update({
      where: { id },
      data: { extractLeaseUntil: new Date(Date.now() - 1000) },
    });

    // Worker B re-claims the abandoned row (attempt 2) and finishes.
    const second = await claimNext();
    expect(second?.extractAttempts).toBe(2);

    await __testing.completeJob(id, 2, "extracted", { text: "B's result", chars: 10 });

    // Worker A now finally finishes and tries to write its own result.
    const landed = await __testing.completeJob(id, 1, "failed", { reason: "A's stale result" });

    expect(landed).toBe(false);

    const after = await prisma.file.findUniqueOrThrow({ where: { id } });
    expect(after.extractStatus).toBe("EXTRACTED");
    expect(after.extractedText).toBe("B's result");
    expect(after.extractReason).toBeNull();
  });

  it("cannot resurrect a row that already reached a terminal state", async () => {
    await seedFiles(1);
    const id = `c${"0".repeat(31)}`;

    const claimed = await claimNext();
    expect(await __testing.completeJob(id, claimed!.extractAttempts, "extracted", { text: "done" })).toBe(true);

    // A second write with the very same fencing token must still not land: the row is
    // no longer PROCESSING.
    const again = await __testing.completeJob(id, claimed!.extractAttempts, "failed", {
      reason: "late",
    });

    expect(again).toBe(false);

    const after = await prisma.file.findUniqueOrThrow({ where: { id } });
    expect(after.extractStatus).toBe("EXTRACTED");
    expect(after.extractedText).toBe("done");
  });

  it("records the timeout as a terminal state", async () => {
    await seedFiles(1);
    gate.timesOut = true;

    scheduleSweep();
    gate.release();
    await waitForIdle();

    const after = await prisma.file.findFirstOrThrow();
    expect(after.extractStatus).toBe("FAILED");
    expect(after.extractReason).toMatch(/time limit/i);
    expect(after.extractLeaseUntil).toBeNull();
  });
});
