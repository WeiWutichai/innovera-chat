import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

const upstream = setupChatHarness();
const ME = { userId: "ck_r", email: "r@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

beforeEach(async () => {
  await seedUser({ clerkUserId: "ck_r", email: "r@test.local", status: "ACTIVE" });
});

describe("failure rollback", () => {
  it("leaves no Conversation and no Message when a NEW chat fails", async () => {
    upstream.setMode("http502");

    const res = await post({ message: "will fail" });

    expect(res.status).toBe(502);
    await expect(prisma.conversation.count()).resolves.toBe(0);
    await expect(prisma.message.count()).resolves.toBe(0);
  });

  it("never forwards upstream error text or internal codes to the client", async () => {
    upstream.setMode("http502");

    const body = await post({ message: "will fail" }).then((r) => r.json());
    const raw = JSON.stringify(body);

    expect(raw).not.toContain("UPSTREAM SECRET DETAIL");
    expect(raw).not.toContain("vllm_down");
    expect(raw).not.toMatch(/qwen/i);
    expect(body.correlationId).toEqual(expect.any(String));
  });

  it("leaves no dangling USER message when a turn in an EXISTING conversation fails", async () => {
    const first = await post({ message: "turn one" }).then((r) => r.json());
    const baseline = await prisma.message.count({ where: { conversationId: first.conversationId } });

    upstream.setMode("http502");
    const res = await actingAs(ME, () =>
      POST(chatRequest({ message: "turn two fails", conversationId: first.conversationId }))
    );

    expect(res.status).toBe(502);
    const rows = await prisma.message.findMany({
      where: { conversationId: first.conversationId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(baseline);
    expect(rows[rows.length - 1].role).toBe("ASSISTANT");
  });

  it("does not stack duplicate user turns across a failure and a retry", async () => {
    const first = await post({ message: "turn one" }).then((r) => r.json());
    const cid = first.conversationId;

    upstream.setMode("http502");
    await actingAs(ME, () => POST(chatRequest({ message: "retry me", conversationId: cid })));
    await actingAs(ME, () => POST(chatRequest({ message: "retry me", conversationId: cid })));

    upstream.setMode("ok");
    await actingAs(ME, () => POST(chatRequest({ message: "retry me", conversationId: cid })));

    const rows = await prisma.message.findMany({
      where: { conversationId: cid },
      orderBy: { createdAt: "asc" },
    });

    expect(rows.map((r) => r.role)).toEqual(["USER", "ASSISTANT", "USER", "ASSISTANT"]);
    expect(rows.filter((r) => r.role === "USER" && r.content === "retry me")).toHaveLength(1);
  });

  it("returns 502 and persists nothing when the completion is empty", async () => {
    upstream.setMode("empty");

    const res = await post({ message: "empty answer" });

    expect(res.status).toBe(502);
    await expect(prisma.message.count()).resolves.toBe(0);
  });

  it("maps a non-JSON upstream error to 502 rather than a generic 500", async () => {
    upstream.setMode("nonjson");

    const res = await post({ message: "html error" });

    expect(res.status).toBe(502);
  });

  it("reports conversationId=null when a rolled-back new conversation is gone", async () => {
    upstream.setMode("http502");

    const body = await post({ message: "gone" }).then((r) => r.json());

    expect(body.conversationId).toBeNull();
  });
});

describe("request validation", () => {
  it("returns 400 for malformed JSON rather than 500", async () => {
    const res = await actingAs(ME, () => POST(chatRequest("{not json")));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid request body" });
  });

  it.each([
    [{ message: "" }, "Message is required"],
    [{ message: "   " }, "Message is required"],
    [{}, "Message is required"],
    [{ message: null }, "Message is required"],
    [{ message: "x".repeat(20_001) }, "Message is too long"],
  ])("rejects %j with 400", async (body, expected) => {
    const res = await actingAs(ME, () => POST(chatRequest(body)));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expected });
  });

  it("returns 404 for a conversation id that does not exist", async () => {
    const res = await actingAs(ME, () =>
      POST(chatRequest({ message: "hi", conversationId: "nope" }))
    );
    expect(res.status).toBe(404);
  });
});
