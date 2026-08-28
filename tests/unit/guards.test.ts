import { describe, it, expect, afterEach } from "vitest";
import { assertSafeDatabaseUrl, assertLocalUpstream } from "../setup/guards";

const savedAppUrl = process.env.DATABASE_URL;
const savedAllow = process.env.TEST_ALLOW_REMOTE_DB;

afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedAppUrl;
  if (savedAllow === undefined) delete process.env.TEST_ALLOW_REMOTE_DB;
  else process.env.TEST_ALLOW_REMOTE_DB = savedAllow;
});

describe("database URL guard", () => {
  it("accepts a loopback URL", () => {
    delete process.env.DATABASE_URL;
    expect(() =>
      assertSafeDatabaseUrl("postgresql://u:p@127.0.0.1:5432/test", "x")
    ).not.toThrow();
  });

  it("refuses a URL identical to the application's own DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/app";

    expect(() =>
      assertSafeDatabaseUrl("postgresql://u:p@127.0.0.1:5432/app", "TEST_DATABASE_URL")
    ).toThrow(/identical to DATABASE_URL/);
  });

  it("refuses a non-loopback host by default", () => {
    delete process.env.DATABASE_URL;
    delete process.env.TEST_ALLOW_REMOTE_DB;

    expect(() =>
      assertSafeDatabaseUrl("postgresql://u:p@203.154.130.149:5432/chat", "TEST_DATABASE_URL")
    ).toThrow(/not loopback/);
  });

  it("allows a remote host only behind the explicit opt-in", () => {
    delete process.env.DATABASE_URL;
    process.env.TEST_ALLOW_REMOTE_DB = "1";

    expect(() =>
      assertSafeDatabaseUrl("postgresql://u:p@10.0.0.5:5432/scratch", "x")
    ).not.toThrow();
  });

  it("refuses a malformed URL", () => {
    expect(() => assertSafeDatabaseUrl("not a url", "x")).toThrow(/not a valid URL/);
  });
});

describe("upstream guard", () => {
  it("accepts a loopback upstream", () => {
    expect(() => assertLocalUpstream("http://127.0.0.1:4010")).not.toThrow();
  });

  it("refuses anything that is not loopback", () => {
    expect(() => assertLocalUpstream("https://litellm.internal:4000")).toThrow(/not loopback/);
  });
});
