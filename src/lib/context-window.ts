export type ContextMessage = { role: string; content: string };

/**
 * Selects the trailing slice of the conversation that fits the character budget.
 *
 * Walks newest-first and admits only whole messages, so a turn is never truncated
 * mid-content. The newest message is always retained even if it alone exceeds the
 * budget, so a request can never be starved to an empty context. The leading trim
 * preserves the Phase 1 invariant that context never begins with an assistant turn.
 */
export function selectContextWithinBudget(
  ordered: ContextMessage[],
  charBudget: number
) {
  const selected: ContextMessage[] = [];
  let usedChars = 0;

  for (let i = ordered.length - 1; i >= 0; i--) {
    const message = ordered[i];
    const cost = message.content.length;

    if (selected.length > 0 && usedChars + cost > charBudget) {
      break;
    }

    selected.unshift(message);
    usedChars += cost;
  }

  while (selected.length > 1 && selected[0].role !== "USER") {
    const dropped = selected.shift();
    usedChars -= dropped ? dropped.content.length : 0;
  }

  return { selected, usedChars };
}
