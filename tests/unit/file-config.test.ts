import { describe, it, expect, afterEach, vi } from "vitest";
import { fileConfig, CEILINGS, DEFAULTS, storageRoot } from "@/lib/files/config";

const VARS = [
  "FILE_MAX_SIZE_MB",
  "FILE_MAX_PER_UPLOAD",
  "FILE_MAX_BATCH_MB",
  "FILE_STORAGE_QUOTA_MB",
  "FILE_UPLOADS_PER_MINUTE",
  "FILE_STORAGE_ROOT",
];

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  vi.restoreAllMocks();
});

describe("defaults", () => {
  it("uses the approved M1 values when nothing is configured", () => {
    const c = fileConfig();
    expect(c.maxSizeMb).toBe(25);
    expect(c.maxPerUpload).toBe(10);
    expect(c.quotaMb).toBe(2048);
  });

  it("derives byte values consistently", () => {
    const c = fileConfig();
    expect(c.maxSizeBytes).toBe(25 * 1024 * 1024);
    expect(c.quotaBytes).toBe(2048 * 1024 * 1024);
  });
});

describe("environment ceilings", () => {
  it("honours a raised value below the ceiling", () => {
    process.env.FILE_MAX_SIZE_MB = "50";
    expect(fileConfig().maxSizeMb).toBe(50);
  });

  it.each([
    ["FILE_MAX_SIZE_MB", "100000", "maxSizeMb", CEILINGS.maxSizeMb],
    ["FILE_MAX_PER_UPLOAD", "9999", "maxPerUpload", CEILINGS.maxPerUpload],
    ["FILE_STORAGE_QUOTA_MB", "99999999", "quotaMb", CEILINGS.quotaMb],
    ["FILE_MAX_BATCH_MB", "100000", "maxBatchMb", CEILINGS.maxBatchMb],
  ])("clamps %s to its absolute ceiling", (name, value, key, ceiling) => {
    // The point of the ceiling: an operator typo must not create an unbounded upload
    // path on a single-replica host with a shared disk.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[name] = value;

    expect(fileConfig()[key as "maxSizeMb"]).toBe(ceiling);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("value_clamped_to_ceiling");
  });

  it("never reports the offending VALUE of an unrelated variable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FILE_MAX_SIZE_MB = "not-a-number";
    fileConfig();
    expect(warn.mock.calls[0][0]).toContain("FILE_MAX_SIZE_MB");
    expect(warn.mock.calls[0][0]).not.toContain("not-a-number");
  });
});

describe("invalid values", () => {
  it.each(["0", "-5", "1.5", "abc", "unlimited", " "])(
    "falls back to the default for %s",
    (value) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.FILE_MAX_SIZE_MB = value;
      expect(fileConfig().maxSizeMb).toBe(DEFAULTS.maxSizeMb);
    }
  );

  it("treats an empty string as unset without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FILE_MAX_SIZE_MB = "";
    expect(fileConfig().maxSizeMb).toBe(DEFAULTS.maxSizeMb);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("call-time reads", () => {
  it("reflects a change between calls rather than caching at import", () => {
    // Order-independence: tests that set and unset variables must not affect each other.
    expect(fileConfig().maxPerUpload).toBe(10);
    process.env.FILE_MAX_PER_UPLOAD = "3";
    expect(fileConfig().maxPerUpload).toBe(3);
  });
});

describe("storage root", () => {
  it("defaults to the container mount point", () => {
    expect(storageRoot()).toBe("/data/files");
  });

  it("is overridable", () => {
    process.env.FILE_STORAGE_ROOT = "/tmp/other";
    expect(storageRoot()).toBe("/tmp/other");
  });
});

describe("aggregate batch limit", () => {
  it("defaults to 50 MB", () => {
    expect(fileConfig().maxBatchMb).toBe(50);
    expect(fileConfig().maxBatchBytes).toBe(50 * 1024 * 1024);
  });

  it("is capped at an absolute ceiling", () => {
    expect(CEILINGS.maxBatchMb).toBe(200);
  });

  it("bounds peak memory more tightly than per-file x per-count", () => {
    // 25 MB x 10 files = 250 MB without this cap. The aggregate limit is what actually
    // bounds what one request can put in the heap of a single-replica container.
    const c = fileConfig();
    expect(c.maxBatchBytes).toBeLessThan(c.maxSizeBytes * c.maxPerUpload);
  });

  // "1e9" is deliberately NOT in this list: Number("1e9") is a valid integer, so it is
  // clamped to the ceiling rather than rejected. That is the correct behaviour — the
  // value is meaningful, just far too large — and it is covered below.
  it.each(["0", "-1", "9.5", "unlimited", "NaN", ""])(
    "falls back to the default for the malformed value %j",
    (value) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.FILE_MAX_BATCH_MB = value;
      expect(fileConfig().maxBatchMb).toBe(DEFAULTS.maxBatchMb);
    }
  );

  it("clamps rather than rejecting a merely too-large value", () => {
    // The operator's intent (a bigger limit) is honoured as far as is safe, and the
    // clamp is logged so it is discoverable.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FILE_MAX_BATCH_MB = "5000";

    expect(fileConfig().maxBatchMb).toBe(CEILINGS.maxBatchMb);
    expect(warn.mock.calls[0][0]).toContain("value_clamped_to_ceiling");
  });

  it.each(["1e9", "999999999"])("clamps the exponential/huge value %s", (value) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FILE_MAX_BATCH_MB = value;
    expect(fileConfig().maxBatchMb).toBe(CEILINGS.maxBatchMb);
  });
});

describe("every limit has a ceiling", () => {
  it("clamps all four independently", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    process.env.FILE_MAX_SIZE_MB = "999999";
    process.env.FILE_MAX_PER_UPLOAD = "999999";
    process.env.FILE_MAX_BATCH_MB = "999999";
    process.env.FILE_STORAGE_QUOTA_MB = "999999999";

    const c = fileConfig();

    expect(c.maxSizeMb).toBe(CEILINGS.maxSizeMb);
    expect(c.maxPerUpload).toBe(CEILINGS.maxPerUpload);
    expect(c.maxBatchMb).toBe(CEILINGS.maxBatchMb);
    expect(c.quotaMb).toBe(CEILINGS.quotaMb);
  });
});
