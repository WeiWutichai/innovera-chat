import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

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
              // Removing Sec-Fetch-Site is what forces the Origin fallback.
              "sec-fetch-site": null,
              origin: "https://evil.example",
              host: "localhost:3000",
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
              host: "localhost:3000",
            },
          }
        )
      )
    );

    expect(res.status).toBe(200);
  });

  it("ignores a spoofed X-Forwarded-Host — it cannot make a foreign Origin look local", async () => {
    // The regression this locks in: the fallback used to compare Origin against
    // X-Forwarded-Host, a header the client supplies and NGINX does not set. An
    // attacker controlling both headers satisfied the check with them alone.
    const res = await actingAs({ userId: "ck_csrf", email: "c@test.local" }, () =>
      POST(
        chatRequest(
          { message: "csrf" },
          {
            headers: {
              "sec-fetch-site": null,
              origin: "https://evil.example",
              "x-forwarded-host": "evil.example",
              host: "localhost:3000",
            },
          }
        )
      )
    );

    expect(res.status).toBe(403);
  });

  it("allows a same-origin request", async () => {
    const res = await actingAs({ userId: "ck_csrf", email: "c@test.local" }, () =>
      POST(chatRequest({ message: "ok" }))
    );

    expect(res.status).toBe(200);
  });
});

describe("canonical origin (APP_CANONICAL_ORIGIN)", () => {
  const ORIGINAL = process.env.APP_CANONICAL_ORIGIN;

  beforeEach(async () => {
    await seedUser({ clerkUserId: "ck_canon", email: "canon@test.local", status: "ACTIVE" });
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.APP_CANONICAL_ORIGIN;
    else process.env.APP_CANONICAL_ORIGIN = ORIGINAL;
  });

  const send = (headers: Record<string, string | null>) =>
    actingAs({ userId: "ck_canon", email: "canon@test.local" }, () =>
      POST(chatRequest({ message: "hello" }, { headers }))
    );

  it("allows an Origin equal to the canonical origin", async () => {
    process.env.APP_CANONICAL_ORIGIN = "https://chat.example.test";

    const res = await send({
      "sec-fetch-site": null,
      origin: "https://chat.example.test",
    });

    expect(res.status).toBe(200);
  });

  it("rejects an Origin that is not the canonical origin", async () => {
    process.env.APP_CANONICAL_ORIGIN = "https://chat.example.test";

    const res = await send({
      "sec-fetch-site": null,
      origin: "https://evil.example",
    });

    expect(res.status).toBe(403);
  });

  it("does not consult Host or X-Forwarded-Host once a canonical origin is set", async () => {
    process.env.APP_CANONICAL_ORIGIN = "https://chat.example.test";

    // Both host headers claim to be the attacker's origin. The canonical value is the
    // only thing that decides, so the request is still refused.
    const res = await send({
      "sec-fetch-site": null,
      origin: "https://evil.example",
      host: "evil.example",
      "x-forwarded-host": "evil.example",
    });

    expect(res.status).toBe(403);
  });

  it("normalises a trailing slash and default port", async () => {
    process.env.APP_CANONICAL_ORIGIN = "https://chat.example.test/";

    const res = await send({
      "sec-fetch-site": null,
      origin: "https://chat.example.test",
    });

    expect(res.status).toBe(200);
  });

  it("FAILS CLOSED when configured but unparseable", async () => {
    // A typo must stop the request, not silently downgrade to the weaker Host check.
    process.env.APP_CANONICAL_ORIGIN = "not a url";

    const res = await send({
      "sec-fetch-site": null,
      origin: "https://chat.example.test",
    });

    expect(res.status).toBe(403);
  });

  it("FAILS CLOSED for a non-http(s) scheme", async () => {
    process.env.APP_CANONICAL_ORIGIN = "javascript:alert(1)";

    const res = await send({
      "sec-fetch-site": null,
      origin: "https://chat.example.test",
    });

    expect(res.status).toBe(403);
  });

  it("still trusts Sec-Fetch-Site when present, regardless of canonical origin", async () => {
    process.env.APP_CANONICAL_ORIGIN = "https://chat.example.test";

    // Sec-Fetch-Site remains the primary signal; the canonical origin does not weaken it.
    const rejected = await send({ "sec-fetch-site": "cross-site" });
    expect(rejected.status).toBe(403);

    const allowed = await send({ "sec-fetch-site": "same-origin" });
    expect(allowed.status).toBe(200);
  });
});

describe("conversationId validation", () => {
  beforeEach(async () => {
    await seedUser({ clerkUserId: "ck_cid", email: "cid@test.local", status: "ACTIVE" });
  });

  it("rejects an oversized conversationId with 400 and writes nothing", async () => {
    const before = await prisma.conversation.count();

    const res = await actingAs({ userId: "ck_cid", email: "cid@test.local" }, () =>
      POST(chatRequest({ message: "hi", conversationId: "c".repeat(65) }))
    );

    expect(res.status).toBe(400);
    // The 400 must land before any database write.
    expect(await prisma.conversation.count()).toBe(before);
    expect(await prisma.message.count()).toBe(0);
  });

  it("accepts a conversationId at the 64-character boundary", async () => {
    // Length is not the reason this fails — ownership is. A 404 proves the value passed
    // validation and was looked up, rather than being rejected as malformed.
    const res = await actingAs({ userId: "ck_cid", email: "cid@test.local" }, () =>
      POST(chatRequest({ message: "hi", conversationId: "c".repeat(64) }))
    );

    expect(res.status).toBe(404);
  });
});
