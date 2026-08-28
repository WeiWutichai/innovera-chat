// Per-user request rate limiting and concurrency slots.
//
// ============================ SINGLE-REPLICA ONLY ============================
// Both limiters live in this process's memory. They are correct for the current
// deployment, which runs exactly one `chat-app` container. If a second replica is
// ever added (or the container is scaled horizontally), each replica keeps its own
// counters and BOTH limits silently multiply by the replica count.
//
// Moving to multiple replicas REQUIRES replacing these with a shared store —
// Redis (INCR + EXPIRE) or a Postgres table with atomic upserts. The daily token
// quota is unaffected: it is computed from the Usage table and stays correct.
// =============================================================================

const RATE_WINDOW_MS = 60_000;

// How often the stale-key sweep may run. Entries only become collectable once every
// timestamp they hold has aged out of the window, so sweeping faster buys nothing.
const SWEEP_INTERVAL_MS = 60_000;

// userId -> attempt timestamps within the current window
const attempts = new Map<string, number[]>();

// userId -> number of in-flight upstream generations
const inFlight = new Map<string, number>();

let lastSweepAt = 0;

/**
 * Drops timestamps that have aged out of the window, and removes any user key left
 * with no timestamps inside it.
 *
 * Without this, filtering happened only when that same user made another request, so a
 * user who sent one message and never came back kept a key resident for the lifetime
 * of the process — an unbounded leak across the whole user base.
 */
function sweep(now: number) {
  lastSweepAt = now;
  const cutoff = now - RATE_WINDOW_MS;

  for (const [userId, timestamps] of attempts) {
    const live = timestamps.filter((t) => t > cutoff);

    if (live.length === 0) {
      attempts.delete(userId);
    } else if (live.length !== timestamps.length) {
      attempts.set(userId, live);
    }
  }
}

/**
 * Amortised cleanup on the request path: a full sweep runs at most once per
 * SWEEP_INTERVAL_MS regardless of traffic, so cost stays O(users) per minute rather
 * than per request. This is the primary mechanism and needs no timers at all — any
 * user's request collects every other user's stale keys.
 */
function maybeSweep(now: number) {
  if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    sweep(now);
  }
}

// Backstop for the case the lazy sweep cannot cover: the process goes completely idle
// while keys are still resident. Created once per module instance — never one timer per
// user or per request — and unref'd so it never keeps the Node process alive on its own.
// (Under dev HMR a reloaded module gets its own maps and its own unref'd timer; in
// production the module is evaluated once.)
const sweepTimer =
  typeof setInterval === "function"
    ? setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS)
    : null;

if (sweepTimer && typeof (sweepTimer as { unref?: () => void }).unref === "function") {
  (sweepTimer as unknown as { unref: () => void }).unref();
}

/**
 * Records an attempt and reports whether the user is within their per-minute budget.
 *
 * Rejected attempts are recorded too: hammering the endpoint keeps the window full
 * rather than resetting it, so a client cannot spin its way back under the limit.
 */
export function checkRateLimit(
  userId: string,
  limitPerMinute: number,
  now: number = Date.now()
): { allowed: boolean; retryAfterSeconds: number } {
  maybeSweep(now);

  const cutoff = now - RATE_WINDOW_MS;
  const recent = (attempts.get(userId) ?? []).filter((t) => t > cutoff);

  recent.push(now);
  attempts.set(userId, recent);

  if (recent.length <= limitPerMinute) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const oldest = recent[0];
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000)
  );

  return { allowed: false, retryAfterSeconds };
}

/**
 * Takes a concurrency slot, or reports that the user is already at their limit.
 *
 * The read and the write happen with no `await` between them, so on Node's single
 * threaded event loop this check-and-increment is atomic: two concurrent requests
 * cannot both observe the same count and both succeed.
 */
export function acquireSlot(userId: string, maxConcurrent: number): boolean {
  const current = inFlight.get(userId) ?? 0;

  if (current >= maxConcurrent) {
    return false;
  }

  inFlight.set(userId, current + 1);
  return true;
}

/** Idempotent per caller: see createSlotRelease. Deletes the key at zero so the map cannot grow. */
export function releaseSlot(userId: string): void {
  const current = inFlight.get(userId) ?? 0;
  const next = current - 1;

  if (next <= 0) {
    inFlight.delete(userId);
    return;
  }

  inFlight.set(userId, next);
}

/**
 * Returns a release function that runs at most once, however many times it is called.
 * A slot released twice would corrupt the counter downwards and let a user exceed the
 * limit; a slot never released would lock them out permanently.
 */
export function createSlotRelease(userId: string): () => void {
  let released = false;

  return () => {
    if (released) return;
    released = true;
    releaseSlot(userId);
  };
}

/** Test-only introspection. Not used by request handling. */
export function __getCounters() {
  return {
    inFlight: new Map(inFlight),
    attempts: new Map(attempts),
  };
}

/** Test-only: run the sweep at a caller-supplied instant. Not used by request handling. */
export function __runSweep(now: number = Date.now()) {
  sweep(now);
}

/** Test-only reset. Not used by request handling. */
export function __resetLimiters() {
  attempts.clear();
  inFlight.clear();
  lastSweepAt = 0;
}
