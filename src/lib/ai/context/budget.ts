/**
 * Deterministic context budget allocation.
 *
 * ================================ THE INVARIANT ==================================
 * The existing 20,000-character budget (CHAT_CONTEXT_CHAR_BUDGET) remains the single
 * authoritative ceiling. File context lives INSIDE it. Attaching files never raises the
 * total — it redistributes it, so a file-heavy turn carries less history rather than a
 * bigger prompt.
 *
 * ================================= THE SPLIT ====================================
 *   current user message  always included, reserved first
 *   file context          at most FILE_SHARE (50%) of the total, and never more than
 *                         what is left after the current message
 *   conversation history  whatever remains
 *
 * The order matters. Reserving the message first means a long question is never truncated
 * to make room for a document the user attached to ask about it.
 *
 * ============================== FAIR ALLOCATION =================================
 * With several attached files the naive loop — walk the list, give each file whatever is
 * left — lets the first file consume the entire allowance and starves the rest. Asking
 * the model to "compare these two documents" would then send one document and a stub.
 *
 * So the split is MAX-MIN FAIR (progressive filling): every file gets an equal share;
 * any file needing less than its share takes only what it needs and returns the surplus,
 * which is then divided equally among the files still short. Repeat until nothing more
 * can be given. Small files are always served in full, and large files divide the rest
 * evenly between them.
 *
 * It is deterministic: identical inputs in the same order always produce identical
 * allocations, with leftover characters going to the earliest files by attachment order.
 */

/** Share of the total budget that file context may occupy. */
export const FILE_SHARE = 0.5;

/**
 * Below this, a slice is not worth sending. A 100-character window onto a 400,000
 * character report is not "partial coverage", it is a misleading fragment — so a file
 * that cannot be given a usable slice is dropped from the prompt entirely and reported
 * as omitted, rather than represented by a stub.
 */
export const MIN_USEFUL_CHARS = 500;

export type BudgetPlan = {
  total: number;
  currentMessage: number;
  fileAllowance: number;
  historyAllowance: number;
};

/**
 * Splits the total budget. `fileAllowance` is the CEILING for files, not a reservation:
 * whatever files do not use is returned to history by `withFileUsage`.
 */
export function planBudget(total: number, currentMessageChars: number): BudgetPlan {
  const currentMessage = Math.min(currentMessageChars, total);
  const afterMessage = Math.max(0, total - currentMessage);
  const fileAllowance = Math.min(Math.floor(total * FILE_SHARE), afterMessage);

  return {
    total,
    currentMessage,
    fileAllowance,
    historyAllowance: afterMessage - fileAllowance,
  };
}

/** Returns the unused file allowance to history, so nothing is wasted. */
export function withFileUsage(plan: BudgetPlan, fileCharsUsed: number): BudgetPlan {
  const used = Math.min(fileCharsUsed, plan.fileAllowance);

  return {
    ...plan,
    fileAllowance: used,
    historyAllowance: plan.total - plan.currentMessage - used,
  };
}

/**
 * Max-min fair division of `budget` across `needs`, preserving index order.
 *
 * Leftover characters that cannot divide evenly go to the earliest indices, which is
 * what makes the result reproducible rather than merely fair.
 */
export function allocateFairly(needs: number[], budget: number): number[] {
  const allocation = new Array<number>(needs.length).fill(0);

  if (needs.length === 0 || budget <= 0) return allocation;

  let remaining = budget;
  let unresolved = needs.map((_, i) => i);

  while (unresolved.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / unresolved.length);

    // Fewer characters left than files still short: hand out the remainder one character
    // at a time in index order rather than losing it to rounding.
    if (share === 0) {
      for (let i = 0; i < unresolved.length && remaining > 0; i++) {
        allocation[unresolved[i]] += 1;
        remaining -= 1;
      }
      break;
    }

    const satisfied = unresolved.filter((i) => needs[i] - allocation[i] <= share);

    if (satisfied.length === 0) {
      // Everyone still wants more than an equal share: split evenly and stop.
      for (const i of unresolved) {
        allocation[i] += share;
        remaining -= share;
      }

      for (let k = 0; k < unresolved.length && remaining > 0; k++) {
        allocation[unresolved[k]] += 1;
        remaining -= 1;
      }

      break;
    }

    for (const i of satisfied) {
      const take = needs[i] - allocation[i];
      allocation[i] += take;
      remaining -= take;
    }

    unresolved = unresolved.filter((i) => !satisfied.includes(i));
  }

  return allocation;
}

export type FileAllocation = {
  /** Index into the input array. */
  index: number;
  chars: number;
  /** True when the file's whole text fits. */
  complete: boolean;
};

/**
 * Allocates the file allowance, dropping files that cannot receive a usable slice.
 *
 * Dropping is by REVERSE attachment order — the most recently attached file is sacrificed
 * first — so the files a user attached earliest, which are the ones their question is
 * most likely anchored on, keep their content. Deterministic for identical inputs.
 */
export function allocateFileBudget(
  needs: number[],
  allowance: number
): { allocations: FileAllocation[]; droppedIndices: number[] } {
  const active = needs.map((_, i) => i);
  const dropped: number[] = [];

  for (;;) {
    if (active.length === 0) break;

    const shares = allocateFairly(
      active.map((i) => needs[i]),
      allowance
    );

    // A file is starved when it gets less than a usable slice AND less than it needs.
    // A small file served in full is not starved, however small it is.
    const starvedAt = shares.findIndex(
      (given, k) => given < Math.min(needs[active[k]], MIN_USEFUL_CHARS)
    );

    if (starvedAt === -1) {
      return {
        allocations: active.map((index, k) => ({
          index,
          chars: shares[k],
          complete: shares[k] >= needs[index],
        })),
        droppedIndices: dropped.sort((a, b) => a - b),
      };
    }

    // Sacrifice the last attached file and re-divide among the rest.
    dropped.push(active.pop() as number);
  }

  return { allocations: [], droppedIndices: dropped.sort((a, b) => a - b) };
}
