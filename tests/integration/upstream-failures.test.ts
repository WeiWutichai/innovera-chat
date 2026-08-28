import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

const upstream = setupChatHarness();
const ME = { userId: "ck_e", email: "e@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

beforeEach(async () => {
  await seedUser({ clerkUserId: "ck_e", email: "e@test.local", status: "ACTIVE" });
});

describe.each(["http502", "http429", "nonjson"] as const)("upstream failure: %s", (mode) => {
  it("returns 502 with reason=upstream and rolls the turn back", async () => {
    upstream.setMode(mode);

    const res = await post({ message: `probe ${mode}` });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.reason).toBe("upstream");
    await expect(prisma.conversation.count()).resolves.toBe(0);
    await expect(prisma.message.count()).resolves.toBe(0);
  });

  it("leaks no upstream detail and always carries a correlation id", async () => {
    upstream.setMode(mode);

    const body = await post({ message: `probe ${mode}` }).then((r) => r.json());
    const raw = JSON.stringify(body);

    expect(raw).not.toContain("UPSTREAM SECRET DETAIL");
    expect(raw).not.toContain("vllm_down");
    expect(raw).not.toContain("nginx");
    expect(body.correlationId).toEqual(expect.any(String));
  });
});

describe("user-facing wording", () => {
  it("distinguishes an overloaded backend from a generic outage", async () => {
    upstream.setMode("http429");
    const busy = await post({ message: "busy" }).then((r) => r.json());

    upstream.setMode("http502");
    const down = await post({ message: "down" }).then((r) => r.json());

    expect(busy.error).not.toBe(down.error);
    expect(busy.error).toContain("ผู้ใช้งานจำนวนมาก");
  });
});

describe("misconfiguration", () => {
  it("returns 503 before any database write when upstream config is missing", async () => {
    const savedUrl = process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_BASE_URL;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await post({ message: "no config" });
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.reason).toBe("not_configured");
      await expect(prisma.conversation.count()).resolves.toBe(0);
    } finally {
      process.env.LITELLM_BASE_URL = savedUrl;
      error.mockRestore();
    }
  });
});
