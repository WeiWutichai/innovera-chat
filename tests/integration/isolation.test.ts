import { describe, it, expect, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { GET as getConversation } from "@/app/api/conversations/[id]/route";
import { GET as listConversations } from "@/app/api/conversations/route";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest, conversationRequest, routeParams } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

setupChatHarness();

const A = { userId: "ck_a", email: "a@test.local" };
const B = { userId: "ck_b", email: "b@test.local" };

async function setupTwoUsers() {
  await seedUser({ clerkUserId: "ck_a", email: "a@test.local" });
  await seedUser({ clerkUserId: "ck_b", email: "b@test.local" });

  const res = await actingAs(A, () => POST(chatRequest({ message: "A private secret" })));
  const { conversationId } = await res.json();
  return conversationId as string;
}

describe("conversation ownership", () => {
  it("returns 404 when user B reads user A's conversation", async () => {
    const id = await setupTwoUsers();

    const res = await actingAs(B, () =>
      getConversation(conversationRequest(id), routeParams(id))
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "Conversation not found" });
  });

  it("gives the same 404 for a nonexistent id, leaking no existence oracle", async () => {
    await setupTwoUsers();

    const res = await actingAs(B, () =>
      getConversation(conversationRequest("does-not-exist"), routeParams("does-not-exist"))
    );

    expect(res.status).toBe(404);
  });

  it("refuses to append to another user's conversation and writes nothing", async () => {
    const id = await setupTwoUsers();
    const before = await prisma.message.count({ where: { conversationId: id } });

    const res = await actingAs(B, () =>
      POST(chatRequest({ message: "B injecting", conversationId: id }))
    );

    expect(res.status).toBe(404);
    await expect(prisma.message.count({ where: { conversationId: id } })).resolves.toBe(before);
  });

  it("still lets the owner read their own conversation", async () => {
    const id = await setupTwoUsers();

    const res = await actingAs(A, () =>
      getConversation(conversationRequest(id), routeParams(id))
    );

    expect(res.status).toBe(200);
  });

  it("scopes the conversation list to the caller", async () => {
    await setupTwoUsers();

    const aList = await actingAs(A, () => listConversations()).then((r) => r.json());
    const bList = await actingAs(B, () => listConversations()).then((r) => r.json());

    expect(aList.conversations).toHaveLength(1);
    expect(bList.conversations).toHaveLength(0);
  });

  it("refuses the conversation list for a non-ACTIVE user", async () => {
    await seedUser({ clerkUserId: "ck_pend", email: "pend@test.local", status: "PENDING" });

    const res = await actingAs({ userId: "ck_pend", email: "pend@test.local" }, () =>
      listConversations()
    );

    expect(res.status).toBe(403);
  });
});
