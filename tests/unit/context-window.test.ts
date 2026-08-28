import { describe, it, expect } from "vitest";
import { selectContextWithinBudget, type ContextMessage } from "@/lib/context-window";

const BUDGET = 20_000; // the Phase 2 production default

const msg = (role: string, content: string): ContextMessage => ({ role, content });
const chars = (role: string, n: number) => msg(role, role[0].repeat(n));

/**
 * These lock in the behaviour that shipped in Phase 2, before the function was moved
 * out of the route handler. The extraction must not change any of it.
 */
describe("context budget selection", () => {
  it("returns everything when the conversation fits", () => {
    const ordered = [msg("USER", "hi"), msg("ASSISTANT", "hello"), msg("USER", "again")];
    const { selected, usedChars } = selectContextWithinBudget(ordered, BUDGET);

    expect(selected).toEqual(ordered);
    expect(usedChars).toBe("hi".length + "hello".length + "again".length);
  });

  it("bounds the context by total characters, keeping the newest turns", () => {
    const ordered = [
      chars("USER", 6000), chars("ASSISTANT", 6000),
      chars("USER", 6000), chars("ASSISTANT", 6000),
      chars("USER", 6000), chars("ASSISTANT", 6000),
      msg("USER", "final question"),
    ];

    const { selected, usedChars } = selectContextWithinBudget(ordered, BUDGET);

    expect(usedChars).toBeLessThanOrEqual(BUDGET);
    expect(selected.length).toBeLessThan(ordered.length);
    // newest is always last
    expect(selected[selected.length - 1].content).toBe("final question");
  });

  it("admits only whole messages, never a truncated one", () => {
    const ordered = [chars("USER", 15_000), chars("ASSISTANT", 15_000), msg("USER", "now")];
    const { selected } = selectContextWithinBudget(ordered, BUDGET);

    for (const message of selected) {
      const original = ordered.find((o) => o.content === message.content);
      expect(original).toBeDefined();
      expect(message.content.length).toBe(original!.content.length);
    }
  });

  it("always retains the current user message, even when it alone exceeds the budget", () => {
    const huge = "U".repeat(BUDGET + 5_000);
    const ordered = [chars("USER", 500), chars("ASSISTANT", 500), msg("USER", huge)];

    const { selected } = selectContextWithinBudget(ordered, BUDGET);

    expect(selected).toHaveLength(1);
    expect(selected[0].content).toBe(huge);
  });

  it("never begins with an ASSISTANT turn", () => {
    // A budget that would otherwise cut the window so it starts mid-turn.
    const ordered = [
      chars("USER", 4000), chars("ASSISTANT", 4000),
      chars("USER", 4000), chars("ASSISTANT", 4000),
      msg("USER", "latest"),
    ];

    const { selected } = selectContextWithinBudget(ordered, 9_000);

    expect(selected[0].role).toBe("USER");
  });

  it("keeps usedChars consistent with the messages actually returned", () => {
    const ordered = [
      chars("USER", 3000), chars("ASSISTANT", 3000),
      chars("USER", 3000), chars("ASSISTANT", 3000),
      msg("USER", "tail"),
    ];

    const { selected, usedChars } = selectContextWithinBudget(ordered, 7_000);
    const actual = selected.reduce((n, m) => n + m.content.length, 0);

    expect(usedChars).toBe(actual);
  });

  it("handles a single message and an empty list without throwing", () => {
    expect(selectContextWithinBudget([msg("USER", "solo")], BUDGET).selected).toHaveLength(1);
    expect(selectContextWithinBudget([], BUDGET).selected).toHaveLength(0);
  });

  it("drops a leading ASSISTANT even when the whole history fits the budget", () => {
    // Reproduces the Phase 1 turn-11 shape: the window opens on an assistant turn.
    const ordered = [msg("ASSISTANT", "a"), msg("USER", "u"), msg("ASSISTANT", "a2")];
    const { selected } = selectContextWithinBudget(ordered, BUDGET);

    expect(selected[0].role).toBe("USER");
    expect(selected).toHaveLength(2);
  });
});
