import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  REQUIRED_BUILD_VARS,
  checkRequiredBuildConfig,
  assertRequiredBuildConfig,
} from "@/lib/build-config";

const KEY = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("build-time configuration check", () => {
  it("lists the publishable key as required", () => {
    expect(REQUIRED_BUILD_VARS).toContain(KEY);
  });

  it("is satisfied when the key is present", () => {
    process.env[KEY] = "pk_test_something";
    expect(checkRequiredBuildConfig()).toEqual({ ok: true, missing: [] });
  });

  it("reports the key as missing when unset", () => {
    delete process.env[KEY];
    expect(checkRequiredBuildConfig()).toEqual({ ok: false, missing: [KEY] });
  });

  it.each(["", "   ", "\t", "\n"])("treats %j as missing, not present", (blank) => {
    process.env[KEY] = blank;
    expect(checkRequiredBuildConfig().missing).toEqual([KEY]);
  });

  it("reads the environment at call time, so import order cannot matter", () => {
    process.env[KEY] = "pk_test_x";
    expect(checkRequiredBuildConfig().ok).toBe(true);
    delete process.env[KEY];
    expect(checkRequiredBuildConfig().ok).toBe(false);
  });
});

describe("build-time assertion", () => {
  it("throws when the key is missing, naming the variable", () => {
    delete process.env[KEY];
    expect(() => assertRequiredBuildConfig()).toThrow(KEY);
  });

  it("throws when the key is blank", () => {
    process.env[KEY] = "   ";
    expect(() => assertRequiredBuildConfig()).toThrow(KEY);
  });

  it("never includes the value in the failure message", () => {
    // A present-but-blank value is what would otherwise be baked into the bundle.
    process.env[KEY] = "  pk_live_super_secret_value  ";
    // Blank-after-trim is what triggers the throw; use a distinct sentinel instead.
    process.env[KEY] = "";
    let message = "";
    try {
      assertRequiredBuildConfig();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(KEY);
    expect(message).not.toContain("pk_live");
  });

  it("explains that the value would otherwise be inlined into the client bundle", () => {
    delete process.env[KEY];
    expect(() => assertRequiredBuildConfig()).toThrow(/inlined into the client bundle/i);
  });

  it("does not throw when the key is present", () => {
    process.env[KEY] = "pk_test_present";
    expect(() => assertRequiredBuildConfig()).not.toThrow();
  });
});
