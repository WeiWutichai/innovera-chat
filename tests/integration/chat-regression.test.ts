import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { GET as listConversations } from "@/app/api/conversations/route";
import { GET as getConversation } from "@/app/api/conversations/[id]/route";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest, conversationRequest, routeParams } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

const upstream = setupChatHarness();
const ME = { userId: "ck_g", email: "g@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

beforeEach(async () => {
  await seedUser({ clerkUserId: "ck_g", email: "g@test.local", status: "ACTIVE" });
});

describe("core chat behaviour", () => {
  it("creates a conversation titled from the first message", async () => {
    const res = await post({ message: "first question" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.title).toBe("first question");
    expect(body.conversationId).toEqual(expect.any(String));
  });

  it("truncates a long title to 60 characters plus an ellipsis", async () => {
    const long = "x".repeat(100);
    const body = await post({ message: long }).then((r) => r.json());

    expect(body.title).toBe(long.slice(0, 60) + "...");
  });

  it("carries prior context into the next turn", async () => {
    const first = await post({ message: "first question" }).then((r) => r.json());

    await post({ message: "second question", conversationId: first.conversationId });

    const sent = upstream.lastRequest()!;
    expect(sent.messageCount).toBe(3);
    expect(sent.roles).toEqual(["user", "assistant", "user"]);
    expect(sent.contents[0]).toBe("first question");
  });

  it("reloads the full transcript after a notional page refresh", async () => {
    const first = await post({ message: "q1" }).then((r) => r.json());
    await post({ message: "q2", conversationId: first.conversationId });

    const list = await actingAs(ME, () => listConversations()).then((r) => r.json());
    const detail = await actingAs(ME, () =>
      getConversation(conversationRequest(first.conversationId), routeParams(first.conversationId))
    ).then((r) => r.json());

    expect(list.conversations).toHaveLength(1);
    expect(detail.conversation.messages).toHaveLength(4);
    expect(detail.conversation.messages.map((m: { role: string }) => m.role)).toEqual([
      "USER", "ASSISTANT", "USER", "ASSISTANT",
    ]);
  });

  it("orders the sidebar by most recently updated", async () => {
    const older = await post({ message: "older conversation" }).then((r) => r.json());
    const newer = await post({ message: "newer conversation" }).then((r) => r.json());
    await post({ message: "bump the older one", conversationId: older.conversationId });

    const list = await actingAs(ME, () => listConversations()).then((r) => r.json());

    expect(list.conversations[0].id).toBe(older.conversationId);
    expect(list.conversations[1].id).toBe(newer.conversationId);
  });

  it("bumps updatedAt exactly once per successful turn", async () => {
    const first = await post({ message: "one" }).then((r) => r.json());
    const before = await prisma.conversation.findUniqueOrThrow({
      where: { id: first.conversationId },
    });

    await post({ message: "two", conversationId: first.conversationId });

    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: first.conversationId },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("does not bump updatedAt when the turn fails", async () => {
    const first = await post({ message: "one" }).then((r) => r.json());
    const before = await prisma.conversation.findUniqueOrThrow({
      where: { id: first.conversationId },
    });

    upstream.setMode("http502");
    await post({ message: "fails", conversationId: first.conversationId });

    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: first.conversationId },
    });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});
