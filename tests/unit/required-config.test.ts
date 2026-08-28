import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REQUIRED_RUNTIME_VARS,
  REQUIRED_BUILD_VARS,
  checkRequiredRuntimeConfig,
  checkRequiredBuildConfig,
  reportRequiredConfig,
} from "@/lib/required-config";

const ALL = [...REQUIRED_RUNTIME_VARS, ...REQUIRED_BUILD_VARS];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ALL) {
    saved[name] = process.env[name];
    process.env[name] = `value-for-${name}`;
  }
});

afterEach(() => {
  for (const name of ALL) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

describe("required runtime configuration", () => {
  it("is satisfied when every variable is present", () => {
    expect(checkRequiredRuntimeConfig()).toEqual({ ok: true, missing: [] });
  });

  it.each(REQUIRED_RUNTIME_VARS)("reports %s when it is missing", (name) => {
    delete process.env[name];

    const report = checkRequiredRuntimeConfig();
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([name]);
  });

  it.each(REQUIRED_RUNTIME_VARS)("treats an empty or whitespace %s as missing", (name) => {
    process.env[name] = "   ";
    expect(checkRequiredRuntimeConfig().missing).toContain(name);
  });

  it("reports every missing variable, not just the first", () => {
    for (const name of REQUIRED_RUNTIME_VARS) delete process.env[name];
    expect(checkRequiredRuntimeConfig().missing).toEqual([...REQUIRED_RUNTIME_VARS]);
  });

  it("reads the environment at call time, so results never depend on import order", () => {
    expect(checkRequiredRuntimeConfig().ok).toBe(true);
    delete process.env.DATABASE_URL;
    expect(checkRequiredRuntimeConfig().ok).toBe(false);
    process.env.DATABASE_URL = "restored";
    expect(checkRequiredRuntimeConfig().ok).toBe(true);
  });
});

describe("build-time configuration", () => {
  it("is reported separately and does not gate runtime readiness", () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

    expect(checkRequiredBuildConfig().missing).toEqual(["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]);
    // The server can still serve; the browser bundle is what suffers.
    expect(checkRequiredRuntimeConfig().ok).toBe(true);
  });
});

describe("reporting", () => {
  it("logs missing variables by NAME and never their value", () => {
    const secret = "super-secret-sentinel-value";
    process.env.CLERK_SECRET_KEY = secret;
    delete process.env.LITELLM_API_KEY;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    reportRequiredConfig();

    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("LITELLM_API_KEY");
    expect(logged).not.toContain(secret);
  });

  it("logs nothing when everything is present", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportRequiredConfig().ok).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("never emits a DATABASE_URL value even when it is present but another var is missing", () => {
    process.env.DATABASE_URL = "postgresql://user:hunter2@host:5432/db";
    delete process.env.CLERK_SECRET_KEY;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    reportRequiredConfig();

    expect(error.mock.calls.flat().join(" ")).not.toContain("hunter2");
  });

  it("returns the runtime report so callers can gate on it", () => {
    delete process.env.LITELLM_BASE_URL;
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(reportRequiredConfig()).toEqual({ ok: false, missing: ["LITELLM_BASE_URL"] });
  });
});
