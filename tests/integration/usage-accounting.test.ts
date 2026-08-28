import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

const upstream = setupChatHarness();
const ME = { userId: "ck_u", email: "u@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

let user: Awaited<ReturnType<typeof seedUser>>;

beforeEach(async () => {
  user = await seedUser({ clerkUserId: "ck_u", email: "u@test.local", status: "ACTIVE" });
});

const usageRows = () => prisma.usage.findMany({ where: { userId: user.id } });

describe("usage accounting", () => {
  it("records the token counts the upstream actually reported", async () => {
    await post({ message: "count me" });

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it("fabricates nothing when a failure leaves usage unknown", async () => {
    upstream.setMode("http502");

    await post({ message: "will fail" });

    await expect(usageRows()).resolves.toHaveLength(0);
  });

  it("records genuinely-consumed tokens even when the turn is rolled back", async () => {
    upstream.setMode("empty");

    const res = await post({ message: "empty answer" });

    expect(res.status).toBe(502);
    await expect(prisma.message.count()).resolves.toBe(0);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].totalTokens).toBe(40);
  });

  it("records zeros, never an estimate, when the response omits usage", async () => {
    upstream.setMode("nousage");

    const res = await post({ message: "no usage field" });

    expect(res.status).toBe(200);
    const rows = await usageRows();
    expect(rows[0]).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("writes exactly one usage row per successful turn", async () => {
    await post({ message: "one" });
    await post({ message: "two" });

    await expect(usageRows()).resolves.toHaveLength(2);
  });

  it("stores per-message token counts alongside the assistant reply", async () => {
    await post({ message: "hello" });

    const assistant = await prisma.message.findFirstOrThrow({ where: { role: "ASSISTANT" } });
    expect(assistant).toMatchObject({ promptTokens: 100, outputTokens: 50 });
  });
});

describe("upstream attribution", () => {
  it("sends the internal user id and never the email or Clerk id", async () => {
    await post({ message: "attribute me" });

    const sent = upstream.lastRequest()!;
    expect(sent.user).toBe(user.id);
    expect(sent.rawBody).not.toContain("u@test.local");
    expect(sent.rawBody).not.toContain("ck_u");
  });

  it("sends the innovera-ai alias, never the underlying model identity", async () => {
    await post({ message: "which model" });

    const sent = upstream.lastRequest()!;
    expect(sent.model).toBe("innovera-ai");
    expect(sent.rawBody).not.toMatch(/qwen/i);
  });
});
