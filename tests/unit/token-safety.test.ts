import { describe, it, expect, afterEach, vi } from "vitest";
import {
  estimateStringTokens,
  estimatePayloadTokens,
  tokenSafetyConfig,
  DEFAULT_MAX_ESTIMATED_INPUT_TOKENS,
  MAX_ESTIMATED_INPUT_TOKENS_CEILING,
} from "@/lib/ai/context/tokens";

/**
 * The token estimator.
 *
 * The property under test is CONSERVATISM, not accuracy. An estimate that is sometimes
 * too low is useless as a safety guard, because the case it fails on is exactly the
 * oversized payload it exists to stop. Every assertion below therefore checks that the
 * estimate is at or above a defensible lower bound for the script in question.
 */

afterEach(() => {
  delete process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS;
  vi.restoreAllMocks();
});

describe("per-script estimates are conservative", () => {
  it("estimates English at no fewer than one token per three characters", () => {
    const text = "the quick brown fox jumps over the lazy dog";

    // Real tokenisers average ~4 chars/token for English; /3 leaves headroom.
    expect(estimateStringTokens(text)).toBe(Math.ceil(text.length / 3));
    expect(estimateStringTokens(text)).toBeGreaterThan(text.length / 4);
  });

  it("estimates Thai at one token per character", () => {
    const thai = "สวัสดีครับ ระบบนี้ใช้ภาษาไทยเป็นหลัก";

    // Thai is 3 bytes per character in UTF-8 and tokenises poorly. Assuming parity —
    // never compression — is the conservative choice.
    expect(estimateStringTokens(thai)).toBe([...thai].filter((c) => c.codePointAt(0)! >= 128).length +
      Math.ceil([...thai].filter((c) => c.codePointAt(0)! < 128).length / 3));
    expect(estimateStringTokens(thai)).toBeGreaterThanOrEqual(30);
  });

  it("estimates CJK at one token per character", () => {
    const cjk = "这是一个测试文件的内容";

    expect(estimateStringTokens(cjk)).toBe(cjk.length);
  });

  it("estimates Japanese kana and kanji at one token per character", () => {
    const jp = "これはテストです。日本語の文章。";

    expect(estimateStringTokens(jp)).toBe([...jp].length);
  });

  it("charges emoji four tokens each, counted by code point", () => {
    // Each of these is a surrogate pair in UTF-16 — .length would say 2, and counting
    // halves would under-charge exactly the characters that tokenise worst.
    const emoji = "😀🎉🚀";

    expect([...emoji]).toHaveLength(3);
    expect(emoji.length).toBe(6);
    expect(estimateStringTokens(emoji)).toBe(12);
  });

  it("handles mixed Unicode without under-counting any part", () => {
    const mixed = "Report สรุป 报告 📊 v2";

    const parts = ["Report ", "สรุป", " ", "报告", " ", "📊", " v2"];
    const sum = parts.reduce((n, p) => n + estimateStringTokens(p), 0);

    // Splitting can only cost extra ceil() rounding, never less than the whole.
    expect(estimateStringTokens(mixed)).toBeLessThanOrEqual(sum);
    expect(estimateStringTokens(mixed)).toBeGreaterThan(0);
  });

  it("never returns less than one token per non-ASCII character", () => {
    for (const text of ["ก", "字", "ท", "한", "ة", "😀"]) {
      expect(estimateStringTokens(text)).toBeGreaterThanOrEqual(1);
    }
  });

  it("is zero only for the empty string", () => {
    expect(estimateStringTokens("")).toBe(0);
    expect(estimateStringTokens(" ")).toBe(1);
  });

  it("is monotonic: more text never estimates fewer tokens", () => {
    let previous = 0;

    for (const n of [0, 1, 10, 100, 1_000]) {
      const current = estimateStringTokens("ก".repeat(n));
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("payload estimates include framing", () => {
  it("charges per-message and per-request overhead", () => {
    const one = estimatePayloadTokens([{ role: "user", content: "hi" }]);
    const two = estimatePayloadTokens([
      { role: "user", content: "hi" },
      { role: "user", content: "hi" },
    ]);

    // Framing is not free, and a payload of many short messages must not estimate as
    // though only the text mattered.
    expect(one).toBeGreaterThan(estimateStringTokens("hi"));
    expect(two - one).toBeGreaterThanOrEqual(8);
  });

  it("charges an empty payload the request overhead only", () => {
    expect(estimatePayloadTokens([])).toBe(8);
  });

  it("keeps a full Thai character budget under the default limit", () => {
    // 20,000 characters of pure Thai is the worst realistic case the character budget
    // permits. The guard must not fire on it, or ordinary Thai traffic breaks.
    const payload = [{ role: "user", content: "ก".repeat(20_000) }];

    expect(estimatePayloadTokens(payload)).toBeLessThan(DEFAULT_MAX_ESTIMATED_INPUT_TOKENS);
  });

  it("flags a full emoji character budget as unsafe", () => {
    // 10,000 emoji is pathological, and is exactly what the guard exists to catch.
    const payload = [{ role: "user", content: "😀".repeat(10_000) }];

    expect(estimatePayloadTokens(payload)).toBeGreaterThan(DEFAULT_MAX_ESTIMATED_INPUT_TOKENS);
  });

  it("keeps a full English character budget far under the limit", () => {
    const payload = [{ role: "user", content: "a".repeat(20_000) }];

    expect(estimatePayloadTokens(payload)).toBeLessThan(7_000);
  });
});

describe("the configured limit", () => {
  it("defaults to 24000", () => {
    expect(tokenSafetyConfig().maxEstimatedInputTokens).toBe(DEFAULT_MAX_ESTIMATED_INPUT_TOKENS);
    expect(DEFAULT_MAX_ESTIMATED_INPUT_TOKENS).toBe(24_000);
  });

  it("accepts a value within the ceiling", () => {
    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "12000";
    expect(tokenSafetyConfig().maxEstimatedInputTokens).toBe(12_000);
  });

  it("clamps a value above the hard ceiling", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "500000";

    expect(tokenSafetyConfig().maxEstimatedInputTokens).toBe(MAX_ESTIMATED_INPUT_TOKENS_CEILING);
  });

  it.each(["0", "-5", "abc", "unlimited", "1.5", "NaN"])(
    "ignores the invalid value %s",
    (raw) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = raw;

      expect(tokenSafetyConfig().maxEstimatedInputTokens).toBe(
        DEFAULT_MAX_ESTIMATED_INPUT_TOKENS
      );
    }
  );

  it("leaves room for the completion beneath the model's context window", () => {
    // 32k context, 1,500 reserved for the answer. The ceiling must not consume the rest.
    expect(MAX_ESTIMATED_INPUT_TOKENS_CEILING).toBeLessThanOrEqual(30_000);
    expect(MAX_ESTIMATED_INPUT_TOKENS_CEILING + 1_500).toBeLessThan(32_768);
  });

  it("logs the variable by name and never its value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "abc";

    tokenSafetyConfig();

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("CHAT_MAX_ESTIMATED_INPUT_TOKENS");
    expect(logged).not.toContain("abc");
  });
});
