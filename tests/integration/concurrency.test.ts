import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { chatConfig } from "@/lib/chat-config";
import { __getCounters } from "@/lib/rate-limiter";
import { actingAs } from "../setup/clerk";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

const upstream = setupChatHarness();
const ME = { userId: "ck_c", email: "c@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

let user: Awaited<ReturnType<typeof seedUser>>;

beforeEach(async () => {
  user = await seedUser({ clerkUserId: "ck_c", email: "c@test.local", status: "ACTIVE" });
});

const inFlightFor = (id: string) => __getCounters().inFlight.get(id) ?? 0;

describe("per-user concurrency cap", () => {
  it("admits the configured number of simultaneous generations and rejects the rest", async () => {
    upstream.setMode("ok", 800);

    const responses = await Promise.all(
      Array.from({ length: chatConfig.maxConcurrentPerUser + 1 }, (_, i) =>
        post({ message: `concurrent ${i}` })
      )
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(chatConfig.maxConcurrentPerUser);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);

    const rejected = responses.find((r) => r.status === 429)!;
    await expect(rejected.json()).resolves.toMatchObject({ reason: "concurrency_limit" });
  });

  it("releases every slot after a successful burst", async () => {
    upstream.setMode("ok", 300);
    await Promise.all([post({ message: "a" }), post({ message: "b" })]);

    expect(inFlightFor(user.id)).toBe(0);
  });

  it("releases the slot on every failure and rejection path", async () => {
    for (const mode of ["http502", "empty", "nonjson", "http429"] as const) {
      upstream.setMode(mode);
      await post({ message: `exit ${mode}` });
      expect(inFlightFor(user.id)).toBe(0);
    }

    upstream.setMode("ok");
    await post({ message: "hi", conversationId: "does-not-exist" }); // 404
    expect(inFlightFor(user.id)).toBe(0);

    await actingAs(ME, () => POST(chatRequest("{not json"))); // 400
    expect(inFlightFor(user.id)).toBe(0);
  });

  it("is scoped per user", async () => {
    await seedUser({ clerkUserId: "ck_c2", email: "c2@test.local", status: "ACTIVE" });
    upstream.setMode("ok", 600);

    const [mine, theirs] = await Promise.all([
      Promise.all([post({ message: "m1" }), post({ message: "m2" }), post({ message: "m3" })]),
      actingAs({ userId: "ck_c2", email: "c2@test.local" }, () =>
        POST(chatRequest({ message: "other user" }))
      ),
    ]);

    expect(mine.filter((r) => r.status === 429)).toHaveLength(1);
    expect(theirs.status).toBe(200);
  });
});
