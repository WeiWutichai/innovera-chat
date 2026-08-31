/**
 * Conservative token-safety estimate.
 *
 * ========================== WHY THIS EXISTS SEPARATELY ==========================
 * The 20,000-CHARACTER budget remains the authoritative allocation mechanism: it is
 * deterministic, cheap and reproducible. But characters are a PROXY for tokens, and the
 * ratio is not constant — the same 20,000 characters is roughly 5,000 tokens of English
 * and roughly 20,000 tokens of Thai. A character budget alone therefore cannot promise
 * the payload fits the model's context window.
 *
 * This is the secondary safety check: a deliberately pessimistic estimate, evaluated
 * BEFORE the upstream call, so an oversized prompt is refused rather than discovered by
 * LiteLLM after the GPU has already been committed.
 *
 * ============================ NOT A TOKEN COUNT =================================
 * THIS IS AN ESTIMATE AND MUST NOT BE PRESENTED AS A TOKEN COUNT. No tokenizer is
 * bundled (M3 adds no tokenizer dependency), the real tokenizer lives upstream, and the
 * only number that is ever recorded against a user's quota remains the prompt_tokens
 * LiteLLM actually reports. This estimate is used for one thing: refusing to send.
 *
 * ============================== THE FORMULA =====================================
 * Chosen by inspecting what the payload actually contains — Thai UI copy, Thai and
 * English user text, extracted document text, and an ASCII framing block — and taking
 * the pessimistic side of each:
 *
 *   ASCII-range characters   ceil(n / 3)   English averages ~4 chars/token on byte-level
 *                                          BPE; 3 leaves headroom for punctuation-dense
 *                                          text, code and JSON, which tokenise worse.
 *   Other BMP characters     n * 1         Thai and CJK commonly reach ~1 token per
 *                                          character. Assuming parity rather than any
 *                                          compression is the conservative choice.
 *   Astral characters        n * 4         Emoji, flags and skin-tone sequences are
 *   (code point > 0xFFFF)                  multi-byte and frequently split into several
 *                                          tokens each.
 *   Per message              + 8           Role framing and separators.
 *   Per request              + 8           Envelope.
 *
 * Every term rounds AGAINST us. The estimate is expected to overshoot; that is the point.
 * =================================================================================
 */

/** Framing charged per message in the payload. */
const PER_MESSAGE_OVERHEAD = 8;

/** Framing charged once per request. */
const PER_REQUEST_OVERHEAD = 8;

/**
 * Estimates the tokens one string contributes.
 *
 * Iterated by code point, not by UTF-16 unit, so an emoji counts once as an astral
 * character rather than twice as two halves of a surrogate pair.
 */
export function estimateStringTokens(text: string): number {
  let ascii = 0;
  let bmp = 0;
  let astral = 0;

  for (const character of text) {
    const code = character.codePointAt(0) as number;

    if (code < 128) ascii++;
    else if (code <= 0xffff) bmp++;
    else astral++;
  }

  return Math.ceil(ascii / 3) + bmp + astral * 4;
}

/** Estimates the whole assembled payload, framing included. */
export function estimatePayloadTokens(
  messages: Array<{ role: string; content: string }>
): number {
  let total = PER_REQUEST_OVERHEAD;

  for (const message of messages) {
    total += PER_MESSAGE_OVERHEAD;
    total += estimateStringTokens(message.role);
    total += estimateStringTokens(message.content);
  }

  return total;
}

/**
 * Hard ceiling on the estimated input. Not configurable by design.
 *
 * The upstream model serves a 32k context and the application reserves 1,500 tokens for
 * the completion. 30,000 is the highest input estimate that still leaves room for both
 * the answer and the estimate's own error margin, so no environment value may exceed it.
 */
export const MAX_ESTIMATED_INPUT_TOKENS_CEILING = 30_000;

/**
 * Default limit.
 *
 * Sized against the character budget rather than picked round: 20,000 characters of pure
 * Thai — the worst realistic case the char budget permits — estimates at roughly 20,100
 * tokens, so 24,000 clears ordinary traffic with margin and fires only when something is
 * genuinely wrong (an emoji-dense payload, or a future change that overspends the char
 * budget).
 */
export const DEFAULT_MAX_ESTIMATED_INPUT_TOKENS = 24_000;

function boundedInt(name: string, fallback: number, ceiling: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      JSON.stringify({
        event: "config.invalid_value_ignored",
        variable: name,
        usingDefault: fallback,
      })
    );
    return fallback;
  }

  if (parsed > ceiling) {
    console.warn(
      JSON.stringify({
        event: "config.value_clamped_to_ceiling",
        variable: name,
        requested: parsed,
        ceiling,
      })
    );
    return ceiling;
  }

  return parsed;
}

/** Read at CALL time, never at module load, matching every other config module. */
export function tokenSafetyConfig() {
  return {
    maxEstimatedInputTokens: boundedInt(
      "CHAT_MAX_ESTIMATED_INPUT_TOKENS",
      DEFAULT_MAX_ESTIMATED_INPUT_TOKENS,
      MAX_ESTIMATED_INPUT_TOKENS_CEILING
    ),
  };
}
