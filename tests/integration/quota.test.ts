import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { startOfBangkokDayUtc } from "@/lib/usage-quota";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

setupChatHarness();

const ME = { userId: "ck_q", email: "q@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

let user: Awaited<ReturnType<typeof seedUser>>;

beforeEach(async () => {
  user = await seedUser({ clerkUserId: "ck_q", email: "q@test.local", status: "ACTIVE" });
});

describe("daily token quota", () => {
  it("rejects with 429 once the daily limit is reached, writing nothing", async () => {
    await prisma.usage.create({
      data: { userId: user.id, promptTokens: 30_000, completionTokens: 20_000, totalTokens: 50_000 },
    });

    const res = await post({ message: "over quota" });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body).toMatchObject({ reason: "quota_exceeded", usedToday: 50_000, dailyTokenLimit: 50_000 });
    await expect(prisma.conversation.count()).resolves.toBe(0);
    await expect(prisma.message.count()).resolves.toBe(0);
  });

  it("allows a request one token under the limit", async () => {
    await prisma.usage.create({ data: { userId: user.id, totalTokens: 49_999 } });

    await expect(post({ message: "just under" }).then((r) => r.status)).resolves.toBe(200);
  });

  it("honours a per-user dailyTokenLimit rather than a global constant", async () => {
    await prisma.user.update({ where: { id: user.id }, data: { dailyTokenLimit: 100 } });
    await prisma.usage.create({ data: { userId: user.id, totalTokens: 100 } });

    const body = await post({ message: "custom limit" }).then((r) => r.json());

    expect(body).toMatchObject({ reason: "quota_exceeded", dailyTokenLimit: 100 });
  });

  it("excludes usage from the previous Asia/Bangkok day", async () => {
    const dayStart = startOfBangkokDayUtc(new Date());

    await prisma.usage.create({
      data: { userId: user.id, totalTokens: 90_000, createdAt: new Date(dayStart.getTime() - 1000) },
    });
    await prisma.usage.create({
      data: { userId: user.id, totalTokens: 10, createdAt: new Date(dayStart.getTime() + 1000) },
    });

    expect(dayStart.getUTCHours()).toBe(17); // 00:00 UTC+7
    await expect(post({ message: "new bangkok day" }).then((r) => r.status)).resolves.toBe(200);
  });

  it("counts only the requesting user's usage", async () => {
    const other = await seedUser({ clerkUserId: "ck_other", email: "other@test.local" });
    await prisma.usage.create({ data: { userId: other.id, totalTokens: 500_000 } });

    await expect(post({ message: "not my usage" }).then((r) => r.status)).resolves.toBe(200);
  });
});
