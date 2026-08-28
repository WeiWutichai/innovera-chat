import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { chatConfig } from "@/lib/chat-config";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

const upstream = setupChatHarness();
const ME = { userId: "ck_b", email: "b@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

beforeEach(async () => {
  await seedUser({ clerkUserId: "ck_b", email: "b@test.local", status: "ACTIVE" });
});

async function conversationWithLargeHistory() {
  const first = await post({ message: "seed" }).then((r) => r.json());

  for (let i = 0; i < 8; i++) {
    await prisma.message.create({
      data: { conversationId: first.conversationId, role: "USER", content: "U".repeat(6000) },
    });
    await prisma.message.create({
      data: { conversationId: first.conversationId, role: "ASSISTANT", content: "A".repeat(6000) },
    });
  }

  return first.conversationId as string;
}

describe("context assembly", () => {
  it("bounds the outgoing context by the character budget", async () => {
    const conversationId = await conversationWithLargeHistory();

    const res = await post({ message: "final question", conversationId });
    const sent = upstream.lastRequest()!;

    expect(res.status).toBe(200);
    expect(sent.totalChars).toBeLessThanOrEqual(chatConfig.contextCharBudget);
  });

  it("sends whole messages only", async () => {
    const conversationId = await conversationWithLargeHistory();
    await post({ message: "final question", conversationId });

    for (const content of upstream.lastRequest()!.contents) {
      expect([6000, "seed".length, "final question".length]).toContain(content.length);
    }
  });

  it("always includes the current user message last", async () => {
    const conversationId = await conversationWithLargeHistory();
    await post({ message: "final question", conversationId });

    expect(upstream.lastRequest()!.contents.at(-1)).toBe("final question");
  });

  it("begins the context with a user turn even deep into a conversation", async () => {
    const first = await post({ message: "turn 0" }).then((r) => r.json());

    for (let i = 1; i <= 14; i++) {
      await post({ message: `turn ${i}`, conversationId: first.conversationId });
    }

    const sent = upstream.lastRequest()!;
    expect(sent.roles[0]).toBe("user");
    expect(sent.messageCount).toBeLessThanOrEqual(chatConfig.contextFetchLimit);
  });

  it("never exceeds the fetch limit of 21 messages", async () => {
    const first = await post({ message: "turn 0" }).then((r) => r.json());
    for (let i = 1; i <= 20; i++) {
      await post({ message: `turn ${i}`, conversationId: first.conversationId });
    }

    expect(upstream.lastRequest()!.messageCount).toBeLessThanOrEqual(21);
  });
});
