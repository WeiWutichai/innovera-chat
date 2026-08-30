import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LIMITS } from "@/lib/extraction/limits";

/**
 * Timeout semantics.
 *
 * The point of these tests is to pin down what the timeout HONESTLY does. It stops the
 * queue waiting; it does not kill the parser. So what must be proven is not "the parser
 * stopped" — it did not — but that a parser still running (or one that finishes late,
 * successfully or by throwing) cannot affect the outcome the caller already received.
 */

const parser = {
  behaviour: "hang" as "hang" | "resolve-late" | "reject-late" | "fast",
  settle: () => {},
};

vi.mock("@/lib/extraction/parsers/text", () => ({
  textParser: () =>
    new Promise((resolve, reject) => {
      if (parser.behaviour === "fast") {
        resolve({
          status: "extracted",
          text: "fast",
          chars: 4,
          truncated: false,
          metadata: {},
        });
        return;
      }

      parser.settle = () => {
        if (parser.behaviour === "resolve-late") {
          resolve({
            status: "extracted",
            text: "late result",
            chars: 11,
            truncated: false,
            metadata: {},
          });
        } else if (parser.behaviour === "reject-late") {
          reject(new Error("late explosion"));
        }
      };
      // "hang" never settles at all.
    }),
}));

import { runExtraction } from "@/lib/extraction/registry";

const input = () => ({
  buffer: Buffer.from("hello"),
  filename: "a.txt",
  mimeType: "text/plain",
});

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.off("unhandledRejection", onUnhandled);
});

describe("the wall-clock budget", () => {
  it("returns a classified failure when the parser does not finish in time", async () => {
    parser.behaviour = "hang";

    const running = runExtraction(input());
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 10);

    const result = await running;

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/time limit/i);
    // Never an internal message or a stack trace.
    expect(result.reason).not.toMatch(/Error|stack|at /);
  });

  it("does not wait longer than the budget", async () => {
    parser.behaviour = "hang";

    const running = runExtraction(input());

    // One tick short of the budget: still pending.
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs - 100);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    await running;
  });

  it("returns the parser's own result when it finishes in time", async () => {
    parser.behaviour = "fast";

    const result = await runExtraction(input());

    expect(result.status).toBe("extracted");
    expect(result.text).toBe("fast");
  });
});

describe("late completion after the budget has expired", () => {
  it("cannot change the result the caller already received", async () => {
    parser.behaviour = "resolve-late";

    const running = runExtraction(input());
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 10);

    const result = await running;
    expect(result.reason).toMatch(/time limit/i);

    // The parser now finishes successfully, far too late.
    parser.settle();
    await vi.advanceTimersByTimeAsync(10);

    // The value the caller holds is immutable — Promise.race already settled, and the
    // parser has no way to reach back into it. This is why a late completion cannot
    // corrupt state: the ONLY writer is the queue, after this promise resolves.
    expect(result.status).toBe("failed");
    expect(result.text).toBe("");
    expect((result as { text: string }).text).not.toBe("late result");
  });

  it("does not produce an unhandled rejection when the parser throws late", async () => {
    parser.behaviour = "reject-late";

    const running = runExtraction(input());
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 10);

    const result = await running;
    expect(result.reason).toMatch(/time limit/i);

    // Guards the subscription, not a catch block: `Promise.race` keeps its handlers on
    // the parser promise after settling, so this late rejection is already handled. A
    // rewrite that stopped awaiting the parser promise through `race` would make this
    // rejection unhandled — and under --unhandled-rejections=strict, fatal.
    parser.settle();
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    expect(unhandled).toHaveLength(0);
  });

  it("clears the timer when the parser wins, so no handle is left behind", async () => {
    parser.behaviour = "fast";

    await runExtraction(input());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the timeout wins", async () => {
    parser.behaviour = "hang";

    const running = runExtraction(input());
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 10);
    await running;

    expect(vi.getTimerCount()).toBe(0);
  });
});
