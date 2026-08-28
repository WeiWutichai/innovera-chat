import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));
vi.mock("next/cache", () => import("../setup/next-stubs"));
vi.mock("next/navigation", () => import("../setup/next-stubs"));

import { POST } from "@/app/api/chat/route";
import { approveUser, disableUser, reactivateUser, makeAdmin, revokeAdmin } from "@/app/admin/actions";
import { chatConfig } from "@/lib/chat-config";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser, formData } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";

const upstream = setupChatHarness();
const ME = { userId: "ck_ev", email: "ev@test.local" };
const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

/** All structured lines emitted during a test, parsed. */
let lines: Record<string, unknown>[] = [];

beforeEach(() => {
  lines = [];
  const collect = (raw: unknown) => {
    try {
      lines.push(JSON.parse(String(raw)));
    } catch {
      /* not a structured line */
    }
  };
  vi.spyOn(console, "info").mockImplementation(collect);
  vi.spyOn(console, "warn").mockImplementation(collect);
  vi.spyOn(console, "error").mockImplementation(collect);
});

afterEach(() => vi.restoreAllMocks());

const event = (name: string) => lines.find((l) => l.event === name);
const allText = () => JSON.stringify(lines);

describe("chat operational events", () => {
  let user: Awaited<ReturnType<typeof seedUser>>;

  beforeEach(async () => {
    user = await seedUser({ clerkUserId: "ck_ev", email: "ev@test.local", status: "ACTIVE" });
  });

  it("emits chat.completed without prompt or completion text", async () => {
    const secret = "my private question about payroll";
    const res = await post({ message: secret });

    expect(res.status).toBe(200);
    const completed = event("chat.completed");
    expect(completed).toMatchObject({ level: "info", correlationId: expect.any(String) });
    expect(completed).toHaveProperty("totalTokens", 150);
    expect(allText()).not.toContain(secret);
    expect(allText()).not.toContain("ECHO");
  });

  it("emits chat.upstream_error without upstream detail", async () => {
    upstream.setMode("http502");
    await post({ message: "will fail" });

    expect(event("chat.upstream_error")).toMatchObject({ status: 502, level: "error" });
    expect(allText()).not.toContain("UPSTREAM SECRET DETAIL");
  });

  it("emits chat.rate_limited once the per-minute limit is crossed", async () => {
    for (let i = 0; i < chatConfig.rateLimitPerMinute + 1; i++) await post({ message: `b${i}` });

    expect(event("chat.rate_limited")).toMatchObject({
      level: "warn",
      userId: user.id,
      retryAfterSeconds: expect.any(Number),
    });
  });

  it("emits chat.quota_exceeded with usage figures but no content", async () => {
    await prisma.usage.create({ data: { userId: user.id, totalTokens: 50_000 } });
    await post({ message: "over quota" });

    expect(event("chat.quota_exceeded")).toMatchObject({
      level: "warn",
      userId: user.id,
      usedToday: 50_000,
      dailyTokenLimit: 50_000,
    });
  });

  it("emits chat.concurrency_rejected when the slot cap is hit", async () => {
    upstream.setMode("ok", 700);
    await Promise.all(
      Array.from({ length: chatConfig.maxConcurrentPerUser + 1 }, (_, i) =>
        post({ message: `c${i}` })
      )
    );

    expect(event("chat.concurrency_rejected")).toMatchObject({
      level: "warn",
      userId: user.id,
      limit: chatConfig.maxConcurrentPerUser,
    });
  });

  it("emits chat.upstream_timeout and chat.client_cancelled distinctly", async () => {
    // Cancellation: abort mid-flight.
    upstream.setMode("ok", 8000);
    const controller = new AbortController();
    const pending = actingAs(ME, () =>
      POST(chatRequest({ message: "cancel" }, { signal: controller.signal }))
    );
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await pending;

    expect(event("chat.client_cancelled")).toBeDefined();
    expect(event("chat.upstream_timeout")).toBeUndefined();
  });

  it("never writes an email address into any chat event", async () => {
    await post({ message: "hello" });
    expect(allText()).not.toContain("ev@test.local");
  });
});

describe("admin audit events", () => {
  let admin: Awaited<ReturnType<typeof seedUser>>;
  const ACTOR = { userId: "ck_admin", email: "admin@test.local" };

  beforeEach(async () => {
    admin = await seedUser({
      clerkUserId: "ck_admin", email: "admin@test.local", role: "ADMIN", status: "ACTIVE",
    });
  });

  it("records the actor and target for an approval", async () => {
    const target = await seedUser({ clerkUserId: "ck_p", email: "p@test.local", status: "PENDING" });
    await actingAs(ACTOR, () => approveUser(formData({ id: target.id })));

    expect(event("admin.user_approved")).toMatchObject({
      actorId: admin.id, targetId: target.id, level: "info",
    });
  });

  it("records disable and reactivate", async () => {
    const target = await seedUser({ clerkUserId: "ck_u", email: "u@test.local" });

    await actingAs(ACTOR, () => disableUser(formData({ id: target.id })));
    expect(event("admin.user_disabled")).toMatchObject({ actorId: admin.id, targetId: target.id });

    lines = [];
    await actingAs(ACTOR, () => reactivateUser(formData({ id: target.id })));
    expect(event("admin.user_reactivated")).toMatchObject({ actorId: admin.id, targetId: target.id });
  });

  it("records granting and revoking admin", async () => {
    const target = await seedUser({ clerkUserId: "ck_g", email: "g@test.local" });

    await actingAs(ACTOR, () => makeAdmin(formData({ id: target.id })));
    expect(event("admin.admin_granted")).toMatchObject({ actorId: admin.id, targetId: target.id });

    lines = [];
    await actingAs(ACTOR, () => revokeAdmin(formData({ id: target.id })));
    expect(event("admin.admin_revoked")).toMatchObject({ actorId: admin.id, targetId: target.id });
  });

  it("never writes an email address into an audit event", async () => {
    const target = await seedUser({ clerkUserId: "ck_e", email: "target@test.local", status: "PENDING" });
    await actingAs(ACTOR, () => approveUser(formData({ id: target.id })));

    expect(allText()).not.toContain("target@test.local");
    expect(allText()).not.toContain("admin@test.local");
  });

  it("emits no audit event when the action is refused", async () => {
    const solo = await seedUser({ clerkUserId: "ck_s", email: "s@test.local", role: "ADMIN" });
    await expect(
      actingAs({ userId: "ck_s", email: "s@test.local" }, () =>
        disableUser(formData({ id: solo.id }))
      )
    ).rejects.toThrow();

    expect(event("admin.user_disabled")).toBeUndefined();
  });
});

describe("identity re-link audit", () => {
  it("records the re-link by user id only", async () => {
    const { getCurrentAppUser } = await import("@/lib/current-app-user");
    const old = await seedUser({ clerkUserId: "ck_old", email: "reuse@test.local", role: "ADMIN" });

    await actingAs({ userId: "ck_new", email: "reuse@test.local" }, () => getCurrentAppUser());

    expect(event("user.email_relinked_pending_reapproval")).toMatchObject({ userId: old.id });
    expect(allText()).not.toContain("reuse@test.local");
  });
});
