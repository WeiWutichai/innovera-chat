import { describe, it, expect, afterAll, afterEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { GET as live } from "@/app/api/health/live/route";
import { GET as ready } from "@/app/api/health/ready/route";
import { REQUIRED_RUNTIME_VARS } from "@/lib/required-config";
import { prisma } from "../setup/database";
import { signedOut } from "../setup/clerk";

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(() => vi.restoreAllMocks());

describe("/api/health/live", () => {
  it("returns 200 while signed out", async () => {
    signedOut();
    const res = await live();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("does not touch the database", async () => {
    // If liveness queried the database, a brief blip would make the container
    // healthcheck kill a healthy application.
    const query = vi.spyOn(prisma, "$queryRaw");
    await live();
    expect(query).not.toHaveBeenCalled();
  });

  it("succeeds even when required configuration is missing", async () => {
    const saved = process.env.LITELLM_API_KEY;
    delete process.env.LITELLM_API_KEY;
    try {
      expect((await live()).status).toBe(200);
    } finally {
      process.env.LITELLM_API_KEY = saved;
    }
  });

  it("reveals no version, hostname or internal detail", async () => {
    const body = await (await live()).json();
    expect(Object.keys(body)).toEqual(["ok"]);
  });
});

describe("/api/health/ready", () => {
  it("returns 200 when configuration is complete and the database is reachable", async () => {
    signedOut();
    const res = await ready();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ready: true });
  });

  it.each(REQUIRED_RUNTIME_VARS)("returns 503 when %s is missing", async (name) => {
    const saved = process.env[name];
    delete process.env[name];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await ready();
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ ready: false });
      // The variable name reaches the log, never the response body.
      expect(error.mock.calls.flat().join(" ")).toContain(name);
    } finally {
      process.env[name] = saved;
    }
  });

  it("returns 503 when the database is unreachable", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await ready();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ready: false });
  });

  it("does not reveal the failure reason in the body", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(
      new Error("FATAL: password authentication failed for user \"chat\"")
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const raw = await (await ready()).text();

    expect(raw).not.toMatch(/password|authentication|FATAL|connection/i);
    expect(JSON.parse(raw)).toEqual({ ready: false });
  });

  it("does not depend on LiteLLM connectivity", async () => {
    // The GPU backend being unreachable must not remove this instance from service:
    // history, admin and auth still work, and chat returns a clean 502.
    const savedUrl = process.env.LITELLM_BASE_URL;
    process.env.LITELLM_BASE_URL = "http://127.0.0.1:1";
    try {
      expect((await ready()).status).toBe(200);
    } finally {
      process.env.LITELLM_BASE_URL = savedUrl;
    }
  });

  it("is reachable signed out", async () => {
    signedOut();
    expect([200, 503]).toContain((await ready()).status);
  });
});
