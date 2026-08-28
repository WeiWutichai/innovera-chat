import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { __resetLimiters } from "@/lib/rate-limiter";
import { actingAs, signedOut } from "../setup/clerk";
import { UpstreamServer } from "../setup/upstream";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";

const upstream = new UpstreamServer();

beforeAll(async () => {
  process.env.LITELLM_BASE_URL = await upstream.start();
  process.env.LITELLM_API_KEY = "test-key-not-a-secret";
});

afterAll(async () => {
  await upstream.stop();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  __resetLimiters();
  upstream.reset();
  signedOut();
});

describe("authentication", () => {
  it("returns JSON 401 for a signed-out request, never HTML", async () => {
    const res = await POST(chatRequest({ message: "hello" }));

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});

describe("account status gate", () => {
  it("rejects a PENDING user", async () => {
    await seedUser({ clerkUserId: "ck_pending", email: "p@test.local", status: "PENDING" });

    const res = await actingAs({ userId: "ck_pending", email: "p@test.local" }, () =>
      POST(chatRequest({ message: "hello" }))
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "Account is not active" });
  });

  it("rejects a DISABLED user", async () => {
    await seedUser({ clerkUserId: "ck_disabled", email: "d@test.local", status: "DISABLED" });

    const res = await actingAs({ userId: "ck_disabled", email: "d@test.local" }, () =>
      POST(chatRequest({ message: "hello" }))
    );

    expect(res.status).toBe(403);
  });

  it("allows an ACTIVE user and persists the turn", async () => {
    await seedUser({ clerkUserId: "ck_active", email: "a@test.local", status: "ACTIVE" });

    const res = await actingAs({ userId: "ck_active", email: "a@test.local" }, () =>
      POST(chatRequest({ message: "hello from active" }))
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toMatch(/^ECHO/);
    await expect(prisma.message.count()).resolves.toBe(2);
  });

  it("rejects a user with no local row at all", async () => {
    const res = await actingAs({ userId: "ck_unknown", email: "u@test.local" }, () =>
      POST(chatRequest({ message: "hello" }))
    );

    expect(res.status).toBe(403);
  });
});

describe("cross-site protection", () => {
  beforeEach(async () => {
    await seedUser({ clerkUserId: "ck_csrf", email: "c@test.local", status: "ACTIVE" });
  });

  it("rejects a cross-site POST carrying a valid session", async () => {
    const res = await actingAs({ userId: "ck_csrf", email: "c@test.local" }, () =>
      POST(chatRequest({ message: "csrf" }, { headers: { "sec-fetch-site": "cross-site" } }))
    );

    expect(res.status).toBe(403);
  });

  it("rejects a foreign Origin when Sec-Fetch-Site is absent", async () => {
    const res = await actingAs({ userId: "ck_csrf", email: "c@test.local" }, () =>
      POST(
        chatRequest(
          { message: "csrf" },
          {
            headers: {
              // Removing Sec-Fetch-Site is what forces the Origin/Host fallback.
              "sec-fetch-site": null,
              origin: "https://evil.example",
              "x-forwarded-host": "localhost:3000",
            },
          }
        )
      )
    );

    expect(res.status).toBe(403);
  });

  it("allows a matching Origin when Sec-Fetch-Site is absent", async () => {
    const res = await actingAs({ userId: "ck_csrf", email: "c@test.local" }, () =>
      POST(
        chatRequest(
          { message: "ok" },
          {
            headers: {
              "sec-fetch-site": null,
              origin: "http://localhost:3000",
              "x-forwarded-host": "localhost:3000",
            },
          }
        )
      )
    );

    expect(res.status).toBe(200);
  });

  it("allows a same-origin request", async () => {
    const res = await actingAs({ userId: "ck_csrf", email: "c@test.local" }, () =>
      POST(chatRequest({ message: "ok" }))
    );

    expect(res.status).toBe(200);
  });
});
