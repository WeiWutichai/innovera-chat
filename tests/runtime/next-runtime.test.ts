import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { UpstreamServer } from "../setup/upstream";
import {
  buildAndStart, createTemporaryProject, assertOutsideRepository,
  type RunningServer, type TempProject,
} from "./next-server";

/**
 * The only suite that exercises the real Next.js server. Everything here is framework
 * behaviour that cannot be observed by calling route handlers directly:
 *   - whether the proxy intercepts /api/chat (it must not, since auth.protect() answers
 *     a non-document request with an HTML 404),
 *   - whether Next aborts request.signal when a client actually disconnects.
 *
 * Opt-in via `npm run test:runtime` because it performs a production build.
 *
 * Everything generated here — the probe route and the entire .next output — lives in a
 * disposable copy of the project under os.tmpdir(). The real working tree is never
 * written to, so a crash mid-test cannot leave it mutated, and teardown can never
 * delete the developer's own build.
 */
let server: RunningServer;
let project: TempProject;
const upstream = new UpstreamServer();

beforeAll(async () => {
  project = createTemporaryProject();
  process.on("exit", () => project?.remove());
  await upstream.start();
  server = await buildAndStart(project);
}, 300_000);

afterAll(async () => {
  await server?.stop();
  await upstream.stop();
  project?.remove();
});

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("isolation", () => {
  it("runs entirely outside the repository working tree", () => {
    expect(project.root.startsWith(process.cwd())).toBe(false);
    expect(() => assertOutsideRepository(project.root)).not.toThrow();
    // The build output belongs to the copy, not the developer's repository.
    expect(existsSync(path.join(project.root, ".next"))).toBe(true);
  });

  it("refuses to generate or delete anything inside the repository", () => {
    expect(() => assertOutsideRepository(process.cwd())).toThrow(/inside the repository/);
    expect(() => assertOutsideRepository(path.join(process.cwd(), "src/app"))).toThrow(
      /inside the repository/
    );
  });

  it("leaves no probe route in the real source tree", () => {
    expect(existsSync(path.join(process.cwd(), "src/app/api/runtime-probe"))).toBe(false);
  });
});

describe("proxy behaviour at the real HTTP edge", () => {
  it("answers a signed-out POST /api/chat with JSON 401, not an HTML 404", async () => {
    const res = await fetch(url("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ message: "hello" }),
    });
    const text = await res.text();

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(text.trimStart().startsWith("<")).toBe(false);
    expect(JSON.parse(text)).toEqual({ error: "Unauthorized" });
  });

  it("answers signed-out conversation routes with JSON 401 too", async () => {
    const res = await fetch(url("/api/conversations"));

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("still runs the proxy on API routes, which is what makes auth() work", async () => {
    const res = await fetch(url("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ message: "hello" }),
    });

    // Clerk only sets this header when its middleware actually executed.
    expect(res.headers.get("x-clerk-auth-status")).toBe("signed-out");
  });
});

describe("security headers", () => {
  // Headers only exist through the real server, so this is the only layer that can
  // assert them. HSTS and CSP are deliberately absent — see next.config.ts.
  it.each([
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["x-frame-options", "DENY"],
  ])("sets %s", async (header, value) => {
    const res = await fetch(url("/api/health/live"));
    expect(res.headers.get(header)).toBe(value);
  });

  it("denies unused browser capabilities", async () => {
    const res = await fetch(url("/api/health/live"));
    const policy = res.headers.get("permissions-policy") ?? "";

    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
  });

  it("does not advertise the framework", async () => {
    const res = await fetch(url("/api/health/live"));
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("does NOT send HSTS — that is NGINX's responsibility", async () => {
    const res = await fetch(url("/api/health/live"));
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("sends CSP in REPORT-ONLY mode, not enforcing", async () => {
    // Phase 3F ships observation only. Enforcing stays off until the policy has been
    // validated in a real browser; NGINX was confirmed to send no CSP of its own, so
    // there is no intersection to worry about.
    const res = await fetch(url("/api/health/live"));

    expect(res.headers.get("content-security-policy-report-only")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("marks API responses no-store", async () => {
    const res = await fetch(url("/api/health/live"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does NOT mark static assets no-store", async () => {
    // /_next/static must keep its immutable caching. Fetch the real asset the landing
    // page references rather than guessing a path.
    const page = await fetch(url("/"));
    const html = await page.text();
    const asset = html.match(/\/_next\/static\/[^"']+?\.(?:css|js)/)?.[0];

    expect(asset).toBeTruthy();

    const res = await fetch(url(asset!));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).not.toBe("no-store");
    expect(res.headers.get("cache-control") ?? "").toContain("immutable");
  });

  it("applies headers to page routes as well as API routes", async () => {
    const res = await fetch(url("/"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("health endpoints through the real server", () => {
  it("serves /api/health/live unauthenticated", async () => {
    const res = await fetch(url("/api/health/live"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("is not intercepted by the Clerk proxy", async () => {
    const res = await fetch(url("/api/health/live"));
    const text = await res.clone().text();

    // An intercepted request would return Next's HTML 404, not JSON.
    expect(text.trimStart().startsWith("<")).toBe(false);
  });
});

describe("client disconnect", () => {
  it("does not abort while the client waits for a normal response", async () => {
    upstream.reset();
    upstream.setMode("ok", 200);

    const res = await fetch(url("/api/runtime-probe"), {
      headers: { "x-probe-upstream": upstream.baseUrl },
    });

    await expect(res.json()).resolves.toMatchObject({ abortFired: false });
    expect(upstream.lastRequest()?.abortedByCaller).toBe(false);
  });

  it("aborts request.signal and severs the upstream fetch when the client goes away", async () => {
    upstream.reset();
    upstream.setMode("ok", 10_000);

    const controller = new AbortController();
    const pending = fetch(url("/api/runtime-probe"), {
      headers: { "x-probe-upstream": upstream.baseUrl },
      signal: controller.signal,
    }).catch(() => "client-aborted" as const);

    await sleep(1000);
    controller.abort();
    await expect(pending).resolves.toBe("client-aborted");

    // Give the server a moment to observe the disconnect and unwind.
    await sleep(1500);

    // Proves Next fired request.signal AND that it propagated to the outbound fetch.
    expect(server.log()).toMatch(/PROBE abort_fired_after_ms=\d+/);
    expect(upstream.lastRequest()?.abortedByCaller).toBe(true);
  });
});

describe("serving runtime contains no build-time tooling", () => {
  /**
   * The Dockerfile's runner stage copies `.next/standalone` (plus static and public) and
   * nothing else, so what this suite builds IS what the serving image ships. Asserting
   * here catches a regression — a stray import pulling the Prisma CLI into the traced
   * graph — without needing Docker in the test path.
   *
   * npm audit reports HIGH advisories against deepmerge-ts, reached only through
   * @prisma/config -> prisma (the CLI). @prisma/client declares the CLI as a production
   * dependency, so this is NOT dev-only in the dependency graph; it is excluded from the
   * serving image purely by file tracing, which is exactly what this test locks in.
   */
  const standalone = () => path.join(project.root, ".next/standalone/node_modules");

  it.each(["prisma", "@prisma/config", "deepmerge-ts"])(
    "does not ship %s in the standalone server output",
    (pkg) => {
      expect(existsSync(path.join(standalone(), pkg))).toBe(false);
    }
  );

  it("does ship the Prisma client the application actually needs", () => {
    expect(existsSync(path.join(standalone(), "@prisma/client"))).toBe(true);
    expect(existsSync(path.join(standalone(), ".prisma"))).toBe(true);
  });

  it("ships no Prisma CLI binary", () => {
    expect(existsSync(path.join(standalone(), ".bin/prisma"))).toBe(false);
  });
});
