import { describe, it, expect } from "vitest";
import {
  planBudget,
  withFileUsage,
  allocateFairly,
  allocateFileBudget,
  FILE_SHARE,
  MIN_USEFUL_CHARS,
} from "@/lib/ai/context/budget";

/**
 * The budget arithmetic, in isolation.
 *
 * The property that matters is not "files get some space" — it is that the TOTAL never
 * grows. Attaching files must redistribute the existing 20,000-character budget, never
 * enlarge it, because the budget is what stands between a user and an unbounded prompt.
 */

const TOTAL = 20_000;

describe("splitting the budget", () => {
  it("reserves the current message before anything else", () => {
    const plan = planBudget(TOTAL, 5_000);

    expect(plan.currentMessage).toBe(5_000);
    expect(plan.currentMessage + plan.fileAllowance + plan.historyAllowance).toBe(TOTAL);
  });

  it("caps file context at half the total", () => {
    const plan = planBudget(TOTAL, 100);

    expect(plan.fileAllowance).toBe(TOTAL * FILE_SHARE);
  });

  it("never lets files push the total over the budget", () => {
    for (const messageChars of [0, 1, 999, 5_000, 12_000, 19_999, 20_000]) {
      const plan = planBudget(TOTAL, messageChars);
      const sum = plan.currentMessage + plan.fileAllowance + plan.historyAllowance;

      expect(sum).toBe(TOTAL);
      expect(plan.fileAllowance).toBeLessThanOrEqual(TOTAL * FILE_SHARE);
    }
  });

  it("gives files nothing when the message alone fills the budget", () => {
    // The message is always included, so a maximal message legitimately leaves no room.
    const plan = planBudget(TOTAL, TOTAL);

    expect(plan.currentMessage).toBe(TOTAL);
    expect(plan.fileAllowance).toBe(0);
    expect(plan.historyAllowance).toBe(0);
  });

  it("clamps a message longer than the whole budget", () => {
    const plan = planBudget(TOTAL, TOTAL + 5_000);

    expect(plan.currentMessage).toBe(TOTAL);
    expect(plan.fileAllowance).toBe(0);
  });

  it("returns unused file allowance to history", () => {
    const plan = withFileUsage(planBudget(TOTAL, 1_000), 2_000);

    // 10,000 was available to files; only 2,000 was used, so history gets the rest.
    expect(plan.fileAllowance).toBe(2_000);
    expect(plan.historyAllowance).toBe(TOTAL - 1_000 - 2_000);
    expect(plan.currentMessage + plan.fileAllowance + plan.historyAllowance).toBe(TOTAL);
  });

  it("history shrinks as file context grows", () => {
    const small = withFileUsage(planBudget(TOTAL, 1_000), 1_000);
    const large = withFileUsage(planBudget(TOTAL, 1_000), 9_000);

    expect(large.historyAllowance).toBeLessThan(small.historyAllowance);
    expect(large.currentMessage).toBe(small.currentMessage);
  });
});

describe("fair division across several files", () => {
  it("gives one file everything it needs when it fits", () => {
    expect(allocateFairly([300], 1_000)).toEqual([300]);
  });

  it("splits evenly when every file wants more than its share", () => {
    expect(allocateFairly([10_000, 10_000], 1_000)).toEqual([500, 500]);
  });

  it("does NOT let the first file consume the whole allowance", () => {
    // The failure this prevents: "compare these two documents" sending one document
    // in full and a stub of the other.
    const [a, b] = allocateFairly([100_000, 100_000], 1_000);

    expect(a).toBe(500);
    expect(b).toBe(500);
  });

  it("serves small files in full and divides the rest among the large ones", () => {
    // 1,000 budget: the 100 is satisfied outright, leaving 900 split between the two
    // large files.
    expect(allocateFairly([100, 10_000, 10_000], 1_000)).toEqual([100, 450, 450]);
  });

  it("never allocates more than the budget", () => {
    const cases: Array<[number[], number]> = [
      [[1], 0],
      [[5, 5, 5], 7],
      [[1_000, 1], 3],
      [[100_000, 2, 3, 4], 11],
      [[0, 0], 100],
    ];

    for (const [needs, budget] of cases) {
      const total = allocateFairly(needs, budget).reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(budget);
    }
  });

  it("never allocates a file more than it needs", () => {
    const needs = [10, 20, 30];
    const given = allocateFairly(needs, 10_000);

    given.forEach((g, i) => expect(g).toBeLessThanOrEqual(needs[i]));
  });

  it("is deterministic for identical input", () => {
    const once = allocateFairly([7_000, 3_000, 11], 5_000);
    const twice = allocateFairly([7_000, 3_000, 11], 5_000);

    expect(once).toEqual(twice);
  });

  it("gives indivisible leftovers to the earliest files", () => {
    // 7 characters, 3 files that each want more: 2 each, and the odd 1 to the first.
    expect(allocateFairly([100, 100, 100], 7)).toEqual([3, 2, 2]);
  });
});

describe("dropping files that cannot get a usable slice", () => {
  it("drops the most recently attached file first", () => {
    // 600 available, three large files: an even split is 200 each, below the usable
    // floor, so files are sacrificed until the survivors get a real slice.
    const { allocations, droppedIndices } = allocateFileBudget([9_000, 9_000, 9_000], 600);

    expect(droppedIndices).toContain(2);
    for (const a of allocations) expect(a.chars).toBeGreaterThanOrEqual(MIN_USEFUL_CHARS);
  });

  it("keeps a small file that fits entirely, however small", () => {
    // Being served in full is not starvation, even below the usable floor.
    const { allocations, droppedIndices } = allocateFileBudget([12], 12);

    expect(droppedIndices).toEqual([]);
    expect(allocations[0]).toMatchObject({ chars: 12, complete: true });
  });

  it("marks a file incomplete when it is truncated", () => {
    const { allocations } = allocateFileBudget([100_000], 5_000);

    expect(allocations[0].complete).toBe(false);
    expect(allocations[0].chars).toBe(5_000);
  });

  it("drops everything when nothing can get a usable slice", () => {
    const { allocations, droppedIndices } = allocateFileBudget([9_000, 9_000], 10);

    expect(allocations).toEqual([]);
    expect(droppedIndices).toEqual([0, 1]);
  });

  it("never exceeds the allowance, whatever the mix", () => {
    const cases: Array<[number[], number]> = [
      [[100_000, 5, 40_000], 3_000],
      [[600, 600, 600], 1_200],
      [[1, 1, 1, 1, 1], 2],
      [[50_000], 499],
    ];

    for (const [needs, allowance] of cases) {
      const { allocations } = allocateFileBudget(needs, allowance);
      const total = allocations.reduce((sum, a) => sum + a.chars, 0);

      expect(total).toBeLessThanOrEqual(allowance);
    }
  });
});
