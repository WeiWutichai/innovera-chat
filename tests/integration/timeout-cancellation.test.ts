import { describe, it, expect, beforeEach, vi } from "vitest";

// Runs before any import, so chat-config reads a short deadline instead of the
// production 540s. Vitest isolates the module registry per file, so this cannot leak.
vi.hoisted(() => {
  process.env.CHAT_UPSTREAM_TIMEOUT_MS = "1500";
});

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { chatConfig } from "@/lib/chat-config";
import { __getCounters } from "@/lib/rate-limiter";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

const upstream = setupChatHarness();
const ME = { userId: "ck_t", email: "t@test.local" };

let user: Awaited<ReturnType<typeof seedUser>>;

beforeEach(async () => {
  user = await seedUser({ clerkUserId: "ck_t", email: "t@test.local", status: "ACTIVE" });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inFlight = () => __getCounters().inFlight.get(user.id) ?? 0;

describe("configuration", () => {
  it("uses the short deadline for this suite", () => {
    expect(chatConfig.upstreamTimeoutMs).toBe(1500);
  });
});

describe("server-side generation timeout", () => {
  it("returns 504 with reason=timeout and rolls the turn back", async () => {
    upstream.setMode("ok", 10_000);

    const res = await actingAs(ME, () => POST(chatRequest({ message: "slow one" })));
    const body = await res.json();

    expect(res.status).toBe(504);
    expect(body.reason).toBe("timeout");
    await expect(prisma.conversation.count()).resolves.toBe(0);
    await expect(prisma.message.count()).resolves.toBe(0);
  });

  it("fabricates no usage for a timed-out request", async () => {
    upstream.setMode("ok", 10_000);
    await actingAs(ME, () => POST(chatRequest({ message: "slow" })));

    await expect(prisma.usage.count()).resolves.toBe(0);
  });

  it("actually severs the upstream connection", async () => {
    upstream.setMode("ok", 10_000);
    await actingAs(ME, () => POST(chatRequest({ message: "slow" })));

    expect(upstream.lastRequest()?.abortedByCaller).toBe(true);
  });

  it("exposes no upstream, model or host detail in the timeout error", async () => {
    upstream.setMode("ok", 10_000);
    const body = await actingAs(ME, () => POST(chatRequest({ message: "slow" }))).then((r) =>
      r.json()
    );
    const raw = JSON.stringify(body);

    expect(raw).not.toMatch(/qwen/i);
    expect(raw).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(body.correlationId).toEqual(expect.any(String));
  });

  it("releases the concurrency slot after a timeout", async () => {
    upstream.setMode("ok", 10_000);
    await actingAs(ME, () => POST(chatRequest({ message: "slow" })));

    expect(inFlight()).toBe(0);
  });
});

describe("client cancellation", () => {
  async function cancelMidFlight() {
    upstream.setMode("ok", 10_000);
    const controller = new AbortController();

    const pending = actingAs(ME, () =>
      POST(chatRequest({ message: "cancel me" }, { signal: controller.signal }))
    );

    await sleep(400);
    controller.abort();
    return pending;
  }

  it("returns 499 with reason=cancelled and rolls the turn back", async () => {
    const res = await cancelMidFlight();
    const body = await res.json();

    expect(res.status).toBe(499);
    expect(body.reason).toBe("cancelled");
    await expect(prisma.conversation.count()).resolves.toBe(0);
    await expect(prisma.message.count()).resolves.toBe(0);
  });

  it("fabricates no usage, because the upstream never reported any", async () => {
    await cancelMidFlight();
    await expect(prisma.usage.count()).resolves.toBe(0);
  });

  it("propagates the abort to the server-side upstream request", async () => {
    await cancelMidFlight();

    // The stand-in observed its inbound connection close before it replied. This proves
    // the server's fetch was aborted; it does NOT prove a real vLLM stops generating.
    expect(upstream.lastRequest()?.abortedByCaller).toBe(true);
  });

  it("releases the concurrency slot after cancellation", async () => {
    await cancelMidFlight();
    expect(inFlight()).toBe(0);
  });

  it("is distinguishable from timeout and upstream failure", async () => {
    const cancelled = await cancelMidFlight().then((r) => r.json());

    upstream.setMode("ok", 10_000);
    const timedOut = await actingAs(ME, () => POST(chatRequest({ message: "slow" }))).then((r) =>
      r.json()
    );

    upstream.setMode("http502");
    const failed = await actingAs(ME, () => POST(chatRequest({ message: "boom" }))).then((r) =>
      r.json()
    );

    expect([cancelled.reason, timedOut.reason, failed.reason]).toEqual([
      "cancelled",
      "timeout",
      "upstream",
    ]);
  });
});
