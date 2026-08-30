import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkRateLimit,
  checkUploadRateLimit,
  acquireSlot,
  createSlotRelease,
  releaseSlot,
  __getCounters,
  __runSweep,
  __resetLimiters,
} from "@/lib/rate-limiter";

const T0 = 1_800_000_000_000; // fixed epoch: results are deterministic
const LIMIT = 10;

/**
 * Internal keys are namespaced per bucket ("chat:alice") so uploads get their own
 * window. These tests assert eviction and compaction behaviour, not the key format, so
 * they address the map through this helper.
 */
const chatKey = (userId: string) => `chat:${userId}`;

beforeEach(() => __resetLimiters());

describe("rolling window", () => {
  it("allows exactly the limit within a minute, then rejects", () => {
    const verdicts = Array.from({ length: 12 }, (_, i) =>
      checkRateLimit("alice", LIMIT, T0 + i).allowed
    );

    expect(verdicts.filter(Boolean)).toHaveLength(10);
    expect(verdicts[10]).toBe(false);
    expect(verdicts[11]).toBe(false);
  });

  it("records rejected attempts rather than discarding them", () => {
    for (let i = 0; i < 12; i++) checkRateLimit("alice", LIMIT, T0 + i);
    expect(__getCounters().attempts.get(chatKey("alice"))).toHaveLength(12);
  });

  it("cannot be spun back under the limit by hammering", () => {
    for (let i = 0; i < 12; i++) checkRateLimit("alice", LIMIT, T0 + i);
    expect(checkRateLimit("alice", LIMIT, T0 + 30_000).allowed).toBe(false);
  });

  it("genuinely rolls once attempts age out", () => {
    for (let i = 0; i < 12; i++) checkRateLimit("alice", LIMIT, T0 + i);
    expect(checkRateLimit("alice", LIMIT, T0 + 61_000).allowed).toBe(true);
  });
});

describe("Retry-After", () => {
  it("counts down against the oldest attempt in the window", () => {
    for (let i = 0; i < LIMIT; i++) checkRateLimit("bob", LIMIT, T0);

    expect(checkRateLimit("bob", LIMIT, T0).retryAfterSeconds).toBe(60);
    expect(checkRateLimit("bob", LIMIT, T0 + 30_000).retryAfterSeconds).toBe(30);
    expect(checkRateLimit("bob", LIMIT, T0 + 59_500).retryAfterSeconds).toBe(1);
  });

  it("is zero while the user is within budget", () => {
    expect(checkRateLimit("bob", LIMIT, T0).retryAfterSeconds).toBe(0);
  });
});

describe("stale key lifecycle", () => {
  it("keeps users whose attempts are still live", () => {
    checkRateLimit("ghost", LIMIT, T0);
    checkRateLimit("active", LIMIT, T0);
    expect(__getCounters().attempts.size).toBe(2);
  });

  it("removes a user who never returns, and keeps a live one", () => {
    checkRateLimit("ghost", LIMIT, T0);
    checkRateLimit("active", LIMIT, T0);
    checkRateLimit("active", LIMIT, T0 + 61_000);

    __runSweep(T0 + 61_000);

    expect([...__getCounters().attempts.keys()]).toEqual([chatKey("active")]);
  });

  it("evicts stale keys on the request path, with no timer involved", () => {
    checkRateLimit("ghost1", LIMIT, T0);
    checkRateLimit("ghost2", LIMIT, T0);
    expect(__getCounters().attempts.size).toBe(2);

    // Another user's request triggers the amortised sweep.
    checkRateLimit("someone-else", LIMIT, T0 + 61_000);

    expect([...__getCounters().attempts.keys()]).toEqual([chatKey("someone-else")]);
  });

  it("is amortised rather than running on every request", () => {
    checkRateLimit("x", LIMIT, T0);
    checkRateLimit("stale", LIMIT, T0);
    checkRateLimit("x", LIMIT, T0 + 5_000); // inside the sweep interval

    expect(__getCounters().attempts.size).toBe(2);
  });

  it("compacts aged timestamps without dropping a still-active user", () => {
    checkRateLimit("mixed", LIMIT, T0);
    checkRateLimit("mixed", LIMIT, T0 + 59_000);

    __runSweep(T0 + 61_000);

    const live = __getCounters().attempts.get(chatKey("mixed"));
    expect(live).toHaveLength(1);
    expect(live?.[0]).toBe(T0 + 59_000);
  });
});

describe("concurrency slots", () => {
  it("caps concurrent acquisitions and is unaffected by sweeps", () => {
    expect(acquireSlot("carol", 2)).toBe(true);
    expect(acquireSlot("carol", 2)).toBe(true);
    expect(__getCounters().inFlight.get("carol")).toBe(2);

    __runSweep(T0 + 10_000_000);

    expect(__getCounters().inFlight.get("carol")).toBe(2);
    expect(acquireSlot("carol", 2)).toBe(false);
  });

  it("releases exactly once however many times the release is called", () => {
    acquireSlot("dave", 2);
    acquireSlot("dave", 2);

    const release = createSlotRelease("dave");
    release();
    release();
    release();

    expect(__getCounters().inFlight.get("dave")).toBe(1);
  });

  it("deletes the key at zero so the map cannot grow unbounded", () => {
    acquireSlot("erin", 2);
    releaseSlot("erin");
    expect(__getCounters().inFlight.has("erin")).toBe(false);
  });
});

describe("sweep timer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates exactly one interval per module instance, and unrefs it", async () => {
    const created: NodeJS.Timeout[] = [];
    const real = globalThis.setInterval;

    vi.stubGlobal("setInterval", ((...args: Parameters<typeof setInterval>) => {
      const timer = real(...args);
      created.push(timer as NodeJS.Timeout);
      return timer;
    }) as typeof setInterval);

    vi.resetModules();
    await import("@/lib/rate-limiter");

    expect(created).toHaveLength(1);
    // An unref'd timer does not hold the event loop open.
    expect(created[0].hasRef()).toBe(false);

    created.forEach((timer) => clearInterval(timer));
  });
});

describe("upload bucket isolation", () => {
  it("does not consume the chat allowance", () => {
    // Exhausting uploads must leave chat untouched; charging both to one window would
    // let a large upload batch lock the user out of conversation entirely.
    for (let i = 0; i < 30; i++) checkUploadRateLimit("bob", 20, T0 + i);

    expect(checkUploadRateLimit("bob", 20, T0 + 40).allowed).toBe(false);
    expect(checkRateLimit("bob", LIMIT, T0 + 41).allowed).toBe(true);
  });

  it("keeps a separate window per bucket", () => {
    checkRateLimit("carol", LIMIT, T0);
    checkUploadRateLimit("carol", 20, T0);

    expect([...__getCounters().attempts.keys()].sort()).toEqual([
      "chat:carol",
      "upload:carol",
    ]);
  });
});
