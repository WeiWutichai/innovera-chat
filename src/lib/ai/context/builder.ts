import { selectContextWithinBudget, type ContextMessage } from "@/lib/context-window";
import { attachFiles, loadActiveFilesForContext } from "@/lib/ai/context/attachments";
import { classify } from "@/lib/ai/context/eligibility";
import { planBudget, withFileUsage } from "@/lib/ai/context/budget";
import { renderFileContext, type ContextFile } from "@/lib/ai/context/prompt";
import { estimatePayloadTokens, tokenSafetyConfig } from "@/lib/ai/context/tokens";

/**
 * Assembles the message array sent upstream.
 *
 * This is the ONE integration point /api/chat has with file context. The route gains a
 * single call; every rule about ownership, activity, eligibility, budget, framing and
 * token safety lives here and is unit-testable without a route, a request or an upstream.
 *
 * ============================ ACTIVE, NOT ASSOCIATED ============================
 * `requestedFileIds` is the ACTIVE set for THIS turn. Only those files contribute
 * extracted text. Files merely ASSOCIATED with the conversation from earlier turns
 * contribute zero characters until the user selects them again.
 *
 * That distinction is the difference between a conversation that stays usable and one
 * that silently fills with documents: injecting the whole association every turn would
 * let one PDF attached on turn 1 consume half the budget on turn 40, crowding out the
 * conversation it was attached to — and would keep spending prompt tokens on it forever.
 *
 * With no active files the assembled result is byte-identical to pre-M3 behaviour: no
 * system message, no file block, the whole budget available to history.
 *
 * ============================== WHY THIS ALSO WRITES ============================
 * The active ids must also become ASSOCIATED, so the attachment survives a reload and can
 * be re-selected later. Rather than making the route perform an authorization-sensitive
 * write of its own, that write is delegated to the attachment service and driven from
 * here — one code path where a file id from a request body turns into an attachment, and
 * it is the path that enforces ownership.
 *
 * ================================ ORDER OF WORK =================================
 *   1. authorize + associate the active ids atomically  (404 on any foreign id)
 *   2. load ONLY the active files, re-scoped to the owner
 *   3. classify each for eligibility     (only EXTRACTED / PARTIAL carry text)
 *   4. split the budget                  (message first, then files, then history)
 *   5. render the untrusted block within its allowance
 *   6. select history from what the files did not use
 *   7. estimate tokens; shrink deterministically if unsafe, else refuse before upstream
 *
 * Ownership and eligibility are both settled in steps 1-3, BEFORE any extracted text is
 * placed into a prompt in step 5.
 * =================================================================================
 */

export type BuildFailure =
  | { ok: false; reason: "forbidden_file" }
  | { ok: false; reason: "context_too_large" };

export type BuildSuccess = {
  ok: true;
  messages: Array<{ role: string; content: string }>;
  stats: {
    totalChars: number;
    budget: number;
    fileChars: number;
    historyChars: number;
    historyMessages: number;
    activeFiles: number;
    filesWithContent: number;
    filesWithoutContent: number;
    filesOmittedForSpace: number;
    estimatedTokens: number;
    estimatedTokenLimit: number;
    /** True when the token guard forced a smaller allocation than the char budget allowed. */
    shrunkForTokens: boolean;
  };
};

export type BuildResult = BuildSuccess | BuildFailure;

/**
 * Deterministic shrink ladder, tried in order until the estimate is safe.
 *
 * Files give way before history, and history gives way before the current message —
 * which is never truncated at any step, because a question the user cannot see the whole
 * of is worse than a refusal. If even the final rung (no files, no history, message
 * alone) is unsafe, the request is refused rather than sent.
 */
const SHRINK_LADDER: Array<{ file: number; history: number }> = [
  { file: 1, history: 1 },
  { file: 0.5, history: 1 },
  { file: 0.25, history: 1 },
  { file: 0.25, history: 0.5 },
  { file: 0, history: 0.5 },
  { file: 0, history: 0.25 },
  { file: 0, history: 0 },
];

function roleFor(role: string): string {
  if (role === "USER") return "user";
  if (role === "ASSISTANT") return "assistant";
  return "system";
}

export async function buildChatContext(input: {
  userId: string;
  conversationId: string;
  currentMessage: string;
  requestedFileIds: string[];
  history: Array<{ role: string; content: string }>;
  budget: number;
}): Promise<BuildResult> {
  const { userId, conversationId, requestedFileIds, history, budget } = input;

  const activeIds = [...new Set(requestedFileIds)];

  // 1. Authorize and associate, atomically. A single foreign id fails the whole request
  //    and nothing is written — see the no-oracle note in attachments.ts.
  if (activeIds.length > 0) {
    const attached = await attachFiles(userId, conversationId, activeIds);
    if (attached === null) return { ok: false, reason: "forbidden_file" };
  }

  // 2. Load ONLY the active files. An empty active set yields an empty list, never the
  //    conversation's whole attachment history.
  const active = await loadActiveFilesForContext(userId, conversationId, activeIds);
  if (active === null) return { ok: false, reason: "forbidden_file" };

  // 3. Eligibility. A file that may not contribute text is still ANNOUNCED, with the
  //    reason, so the model never has to guess why it cannot see a file the user
  //    can see attached.
  const contextFiles: ContextFile[] = active.map((file) => {
    const verdict = classify(file);

    return {
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      text: verdict.eligible ? file.extractedText : null,
      unavailableReason: verdict.eligible ? undefined : verdict.reason,
      extractorTruncated: file.extractTruncated,
    };
  });

  const limit = tokenSafetyConfig().maxEstimatedInputTokens;

  // `newest` guards the invariant if the caller's currentMessage and the newest history
  // row ever disagree.
  const newest = history.length > 0 ? history[history.length - 1].content.length : 0;
  const messageChars = Math.max(input.currentMessage.length, newest);

  let last: { messages: BuildSuccess["messages"]; stats: BuildSuccess["stats"] } | null = null;

  for (let rung = 0; rung < SHRINK_LADDER.length; rung++) {
    const { file: fileFactor, history: historyFactor } = SHRINK_LADDER[rung];

    // 4. The current message is reserved first, at every rung.
    const plan = planBudget(budget, messageChars);
    const fileAllowance = Math.floor(plan.fileAllowance * fileFactor);

    // 5. The whole rendered block — delimiters and headers included — is charged against
    //    the file allowance.
    const rendered = fileFactor > 0 ? renderFileContext(contextFiles, fileAllowance) : null;
    const fileChars = rendered?.text.length ?? 0;

    // 6. Whatever the files did not use returns to history.
    const finalPlan = withFileUsage({ ...plan, fileAllowance }, fileChars);
    const historyAllowance = Math.floor(finalPlan.historyAllowance * historyFactor);

    const { selected, usedChars } = selectContextWithinBudget(
      history as ContextMessage[],
      finalPlan.currentMessage + historyAllowance
    );

    const messages = [
      ...(rendered ? [{ role: "system", content: rendered.text }] : []),
      ...selected.map((m) => ({ role: roleFor(m.role), content: m.content })),
    ];

    const totalChars = fileChars + usedChars;

    // The character budget stays authoritative and is never exceeded at any rung.
    if (totalChars > budget) continue;

    // 7. The secondary safety check.
    const estimatedTokens = estimatePayloadTokens(messages);

    const stats: BuildSuccess["stats"] = {
      totalChars,
      budget,
      fileChars,
      historyChars: usedChars,
      historyMessages: selected.length,
      activeFiles: active.length,
      filesWithContent: rendered?.filesWithContent ?? 0,
      filesWithoutContent: rendered?.filesAnnouncedWithoutContent ?? 0,
      filesOmittedForSpace: rendered?.filesOmittedForSpace ?? 0,
      estimatedTokens,
      estimatedTokenLimit: limit,
      shrunkForTokens: rung > 0,
    };

    last = { messages, stats };

    if (estimatedTokens <= limit) return { ok: true, messages, stats };
  }

  // Every rung was still over the limit — the current message alone is too large for the
  // model. Refuse here, before any GPU time is committed, rather than truncate the user's
  // own question behind their back.
  void last;

  return { ok: false, reason: "context_too_large" };
}
