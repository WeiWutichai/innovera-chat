import { describe, it, expect, vi, afterEach } from "vitest";
import { logEvent, logInfo, logWarn, logError, __redactForTest } from "@/lib/log";

afterEach(() => vi.restoreAllMocks());

function capture(level: "info" | "warn" | "error") {
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
  return vi.spyOn(console, method).mockImplementation(() => {});
}

const parseLast = (spy: ReturnType<typeof capture>) =>
  JSON.parse(spy.mock.calls.at(-1)![0] as string);

describe("envelope", () => {
  it("emits timestamp, level and event", () => {
    const spy = capture("info");
    logInfo("chat.completed");

    const line = parseLast(spy);
    expect(line.event).toBe("chat.completed");
    expect(line.level).toBe("info");
    expect(new Date(line.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("emits a single parseable JSON line", () => {
    const spy = capture("info");
    logInfo("x", { a: 1 });

    const raw = spy.mock.calls.at(-1)![0] as string;
    expect(raw).not.toContain("\n");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("carries the correlation id through", () => {
    const spy = capture("warn");
    logWarn("chat.rate_limited", { correlationId: "abc12345", userId: "u1" });

    expect(parseLast(spy)).toMatchObject({ correlationId: "abc12345", userId: "u1" });
  });

  it("routes each level to the matching console method", () => {
    const info = capture("info"), warn = capture("warn"), error = capture("error");
    logEvent("info", "a"); logEvent("warn", "b"); logEvent("error", "c");

    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});

describe("redaction by field name", () => {
  it.each([
    "authorization", "cookie", "password", "secret", "token", "apiKey",
    "api_key", "database_url", "email", "prompt", "completion", "content", "messages",
  ])("redacts a field named %s", (field) => {
    const out = __redactForTest({ [field]: "value-that-must-not-appear" });
    expect(JSON.stringify(out)).not.toContain("value-that-must-not-appear");
    expect(out[field]).toBe("[redacted]");
  });

  it("keeps benign operational fields intact", () => {
    const out = __redactForTest({
      correlationId: "abc", userId: "u1", status: 502, totalTokens: 150, reason: "upstream",
    });
    expect(out).toEqual({
      correlationId: "abc", userId: "u1", status: 502, totalTokens: 150, reason: "upstream",
    });
  });
});

describe("redaction by value shape", () => {
  it.each([
    ["clerk secret", "sk_test_abcdefghijklmnop"],
    ["clerk live key", "pk_live_abcdefghijklmnop"],
    ["database url", "postgresql://user:hunter2@db:5432/app"],
    ["bearer token", "Bearer abcdefghijklmnopqrst"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("redacts a credential-shaped value even under a harmless field name (%s)", (_label, value) => {
    const out = __redactForTest({ detail: value });
    expect(out.detail).toBe("[redacted]");
  });

  it("redacts inside nested objects and arrays", () => {
    const out = __redactForTest({
      outer: { inner: "postgresql://u:p@h:5432/d" },
      list: ["sk_test_abcdefghijklmnop", "safe"],
    });
    expect(JSON.stringify(out)).not.toContain("hunter");
    expect((out.outer as Record<string, unknown>).inner).toBe("[redacted]");
    expect((out.list as unknown[])[0]).toBe("[redacted]");
    expect((out.list as unknown[])[1]).toBe("safe");
  });

  it("never writes a prompt or completion into a log line", () => {
    const spy = capture("info");
    logInfo("chat.completed", {
      correlationId: "c1",
      prompt: "the user's private question",
      completion: "the model's private answer",
    });

    const raw = spy.mock.calls.at(-1)![0] as string;
    expect(raw).not.toContain("private question");
    expect(raw).not.toContain("private answer");
  });
});

describe("robustness", () => {
  it("does not throw on undefined, null or non-serialisable input", () => {
    const spy = capture("error");
    expect(() =>
      logError("x", { a: undefined, b: null, c: Symbol("s") as unknown as string })
    ).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
