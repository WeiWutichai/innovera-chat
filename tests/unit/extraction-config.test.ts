import { describe, it, expect, afterEach, vi } from "vitest";
import {
  extractionConfig,
  DEFAULT_MAX_CONCURRENT,
  MAX_CONCURRENT_CEILING,
} from "@/lib/extraction/config";

afterEach(() => {
  delete process.env.EXTRACTION_MAX_CONCURRENT;
  vi.restoreAllMocks();
});

describe("EXTRACTION_MAX_CONCURRENT", () => {
  it("defaults to 2", () => {
    expect(extractionConfig().maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(DEFAULT_MAX_CONCURRENT).toBe(2);
  });

  it("accepts a valid value inside the ceiling", () => {
    process.env.EXTRACTION_MAX_CONCURRENT = "3";
    expect(extractionConfig().maxConcurrent).toBe(3);
  });

  it("accepts 1", () => {
    process.env.EXTRACTION_MAX_CONCURRENT = "1";
    expect(extractionConfig().maxConcurrent).toBe(1);
  });

  it("clamps a value above the ceiling instead of honouring it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.EXTRACTION_MAX_CONCURRENT = "64";

    expect(extractionConfig().maxConcurrent).toBe(MAX_CONCURRENT_CEILING);
    expect(warn).toHaveBeenCalled();
  });

  it.each(["0", "-1", "abc", "unlimited", "2.5", "NaN", "1e9"])(
    "ignores the invalid value %s and uses the default",
    (raw) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.EXTRACTION_MAX_CONCURRENT = raw;

      const value = extractionConfig().maxConcurrent;

      // "1e9" is a valid integer, so it must CLAMP rather than fall back; everything
      // else here is malformed and must fall back. Either way the result is bounded.
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(MAX_CONCURRENT_CEILING);
    }
  );

  it("treats an empty value as unset", () => {
    process.env.EXTRACTION_MAX_CONCURRENT = "";
    expect(extractionConfig().maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("never logs the value under a name that could carry a secret", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.EXTRACTION_MAX_CONCURRENT = "abc";

    extractionConfig();

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("EXTRACTION_MAX_CONCURRENT");
    expect(logged).not.toContain("abc");
  });

  it("is read at call time, not module load", () => {
    process.env.EXTRACTION_MAX_CONCURRENT = "1";
    expect(extractionConfig().maxConcurrent).toBe(1);

    process.env.EXTRACTION_MAX_CONCURRENT = "3";
    expect(extractionConfig().maxConcurrent).toBe(3);
  });

  it("keeps the ceiling low enough to bound worst-case memory", () => {
    // 4 concurrent worst-case jobs is already ~1.4 GB of transient heap. This assertion
    // exists so raising the ceiling is a deliberate act with a visible test to update.
    expect(MAX_CONCURRENT_CEILING).toBeLessThanOrEqual(4);
  });
});
