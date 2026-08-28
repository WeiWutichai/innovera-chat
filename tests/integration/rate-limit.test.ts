import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { chatConfig } from "@/lib/chat-config";
import { actingAs } from "../setup/clerk";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

setupChatHarness();

const ME = { userId: "ck_rl", email: "rl@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

beforeEach(async () => {
  await seedUser({ clerkUserId: "ck_rl", email: "rl@test.local", status: "ACTIVE" });
});

describe("per-minute rate limit", () => {
  it("allows the configured number of requests then returns 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < chatConfig.rateLimitPerMinute + 2; i++) {
      statuses.push((await post({ message: `burst ${i}` })).status);
    }

    expect(statuses.filter((s) => s === 200)).toHaveLength(chatConfig.rateLimitPerMinute);
    expect(statuses.at(-1)).toBe(429);
  });

  it("labels the rejection as rate_limited and sends Retry-After", async () => {
    for (let i = 0; i < chatConfig.rateLimitPerMinute; i++) await post({ message: `x${i}` });

    const res = await post({ message: "one too many" });

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(res.json()).resolves.toMatchObject({ reason: "rate_limited" });
  });

  it("is scoped per user", async () => {
    await seedUser({ clerkUserId: "ck_other", email: "other@test.local", status: "ACTIVE" });
    for (let i = 0; i < chatConfig.rateLimitPerMinute + 1; i++) await post({ message: `x${i}` });

    const res = await actingAs({ userId: "ck_other", email: "other@test.local" }, () =>
      POST(chatRequest({ message: "unaffected" }))
    );

    expect(res.status).toBe(200);
  });

  it("rejects before doing any database work", async () => {
    const { prisma } = await import("../setup/database");
    for (let i = 0; i < chatConfig.rateLimitPerMinute; i++) await post({ message: `x${i}` });
    const before = await prisma.conversation.count();

    await post({ message: "rejected" });

    await expect(prisma.conversation.count()).resolves.toBe(before);
  });
});
