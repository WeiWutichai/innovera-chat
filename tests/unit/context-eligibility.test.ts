import { describe, it, expect } from "vitest";
import { classify } from "@/lib/ai/context/eligibility";

/**
 * Which files may contribute text to the prompt.
 *
 * The tests that matter most are the negative ones. A file whose content silently
 * reaches the model despite having failed extraction, or an image the model is allowed
 * to believe it can see, both produce confident answers about something nobody read.
 */

const base = {
  mimeType: "text/plain",
  extractedText: "real content",
  extractTruncated: false,
};

describe("eligible states", () => {
  it("includes EXTRACTED as complete", () => {
    expect(classify({ ...base, extractStatus: "EXTRACTED" })).toEqual({
      eligible: true,
      complete: true,
    });
  });

  it("includes PARTIAL but never as complete", () => {
    // The label is the point: PARTIAL content that reads as complete invites the model
    // to summarise a document it has only seen part of.
    expect(classify({ ...base, extractStatus: "PARTIAL" })).toEqual({
      eligible: true,
      complete: false,
    });
  });

  it("marks an EXTRACTED file incomplete when the extractor truncated it", () => {
    const verdict = classify({ ...base, extractStatus: "EXTRACTED", extractTruncated: true });

    expect(verdict).toEqual({ eligible: true, complete: false });
  });
});

describe("states that must never contribute content", () => {
  it.each(["UNSUPPORTED", "FAILED", "PENDING", "PROCESSING", "SKIPPED"])(
    "excludes %s",
    (extractStatus) => {
      const verdict = classify({ ...base, extractStatus });

      expect(verdict.eligible).toBe(false);
      expect(verdict).toHaveProperty("reason");
    }
  );

  it("explains each exclusion rather than just omitting the file", () => {
    for (const status of ["UNSUPPORTED", "FAILED", "PENDING", "PROCESSING", "SKIPPED"]) {
      const verdict = classify({ ...base, extractStatus: status });

      if (verdict.eligible) throw new Error("expected ineligible");
      expect(verdict.reason).toMatch(/content unavailable/i);
      expect(verdict.reason.length).toBeGreaterThan(20);
    }
  });

  it("excludes an eligible status carrying no text", () => {
    // Trusting the status alone would emit an empty CONTENT block, which reads to the
    // model as "this file is empty" rather than "this file was not read".
    const verdict = classify({ ...base, extractStatus: "EXTRACTED", extractedText: "" });

    expect(verdict.eligible).toBe(false);
  });

  it("excludes an eligible status with null text", () => {
    expect(
      classify({ ...base, extractStatus: "PARTIAL", extractedText: null }).eligible
    ).toBe(false);
  });
});

describe("images", () => {
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "never contributes content for %s",
    (mimeType) => {
      // Even with a status and text that would otherwise qualify.
      const verdict = classify({
        mimeType,
        extractStatus: "EXTRACTED",
        extractedText: "some text that came from somewhere",
        extractTruncated: false,
      });

      expect(verdict.eligible).toBe(false);
    }
  );

  it("tells the model plainly that it cannot see images", () => {
    const verdict = classify({
      mimeType: "image/png",
      extractStatus: "UNSUPPORTED",
      extractedText: null,
      extractTruncated: false,
    });

    if (verdict.eligible) throw new Error("expected ineligible");

    expect(verdict.reason).toMatch(/text-only/i);
    expect(verdict.reason).toMatch(/cannot see images/i);
    // And must not merely omit it, which would leave the model free to guess.
    expect(verdict.reason).toMatch(/must not describe or guess/i);
  });

  it("is checked before the status allowlist", () => {
    // An image that somehow reached EXTRACTED must still contribute nothing.
    const verdict = classify({
      mimeType: "image/png",
      extractStatus: "EXTRACTED",
      extractedText: "x".repeat(1000),
      extractTruncated: false,
    });

    expect(verdict.eligible).toBe(false);
  });
});
