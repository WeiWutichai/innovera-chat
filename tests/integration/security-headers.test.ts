import { describe, it, expect, beforeEach, afterEach } from "vitest";
import config from "../../next.config";

/**
 * next.config.ts resolves headers() at build time into the routes manifest, so this is
 * the layer that can assert the POLICY. tests/runtime/next-runtime.test.ts asserts the
 * headers actually arrive over HTTP from a real server.
 */
async function rules() {
  const cfg = config("phase-development-server");
  return await cfg.headers!();
}

async function headersFor(source: string) {
  const all = await rules();
  const rule = all.find((r) => r.source === source);
  if (!rule) throw new Error(`no header rule for ${source}`);
  return new Map(rule.headers.map((h) => [h.key, h.value]));
}

const ORIGINAL_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const ORIGINAL_ENFORCE = process.env.CSP_ENFORCE;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", ORIGINAL_KEY);
  restore("CSP_ENFORCE", ORIGINAL_ENFORCE);
});

describe("Content-Security-Policy", () => {
  beforeEach(() => {
    delete process.env.CSP_ENFORCE;
  });

  it("ships REPORT-ONLY by default — observation, not enforcement", async () => {
    const h = await headersFor("/:path*");

    expect(h.has("Content-Security-Policy-Report-Only")).toBe(true);
    // Enforcing must stay off until the policy has been validated in a browser.
    expect(h.has("Content-Security-Policy")).toBe(false);
  });

  it("switches to the enforcing header when CSP_ENFORCE=1", async () => {
    process.env.CSP_ENFORCE = "1";
    const h = await headersFor("/:path*");

    expect(h.has("Content-Security-Policy")).toBe(true);
    expect(h.has("Content-Security-Policy-Report-Only")).toBe(false);
  });

  it.each([
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ])("declares %s", async (directive) => {
    const h = await headersFor("/:path*");
    expect(h.get("Content-Security-Policy-Report-Only")).toContain(directive);
  });

  it("does NOT permit unsafe-eval", async () => {
    // Nothing has demonstrated a need for it. If Report-Only surfaces one, that is a
    // finding to review — not a directive to add pre-emptively.
    const h = await headersFor("/:path*");
    expect(h.get("Content-Security-Policy-Report-Only")).not.toContain("unsafe-eval");
  });

  it("uses no wildcard source", async () => {
    const policy = (await headersFor("/:path*")).get("Content-Security-Policy-Report-Only")!;

    // No host wildcard (`*.example.com` or a bare `*`) and no scheme-only source
    // (`https:` / `http:` as a complete token, which would allow every origin).
    expect(policy).not.toMatch(/\s\*/);
    expect(policy).not.toMatch(/\shttps:(?=[\s;]|$)/);
    expect(policy).not.toMatch(/\shttp:(?=[\s;]|$)/);
  });

  it("permits inline script and style, which the current Next.js build requires", async () => {
    // Next 16 emits the streaming RSC payload as bare inline <script> blocks with no
    // nonce, and inline style="" attributes which cannot carry one. Removing these
    // requires nonce propagation and is the prerequisite for enforcing mode.
    const policy = (await headersFor("/:path*")).get("Content-Security-Policy-Report-Only")!;

    expect(policy).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(policy).toMatch(/style-src [^;]*'unsafe-inline'/);
  });

  it("derives the Clerk origin from the publishable key rather than hardcoding it", async () => {
    const host = "clerk.example-derived.test";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
      "pk_test_" + Buffer.from(`${host}$`).toString("base64");

    const policy = (await headersFor("/:path*")).get("Content-Security-Policy-Report-Only")!;

    expect(policy).toContain(`script-src 'self' 'unsafe-inline' https://${host}`);
    expect(policy).toContain(`connect-src 'self' https://${host}`);
    expect(policy).toContain(`frame-src 'self' https://${host}`);
  });

  it("omits the Clerk origin rather than emitting a broken directive when the key is malformed", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_not-valid-base64!!";

    const policy = (await headersFor("/:path*")).get("Content-Security-Policy-Report-Only")!;

    expect(policy).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
    expect(policy).not.toContain("undefined");
    expect(policy).not.toContain("https://null");
  });

  it("allows only the Clerk-owned third-party origins this integration actually loads", async () => {
    const policy = (await headersFor("/:path*")).get("Content-Security-Policy-Report-Only")!;

    expect(policy).toContain("https://img.clerk.com");
    expect(policy).toContain("https://images.clerk.com");
    expect(policy).toContain("https://challenges.cloudflare.com");
    expect(policy).toContain("https://clerk-telemetry.com");
  });
});

describe("Cache-Control", () => {
  it("marks API responses no-store", async () => {
    const h = await headersFor("/api/:path*");
    expect(h.get("Cache-Control")).toBe("no-store");
  });

  it("does not apply no-store to the catch-all rule that also covers static assets", async () => {
    // /_next/static must keep its immutable caching, which is what makes repeat page
    // loads cheap. Only the /api rule may carry no-store.
    const h = await headersFor("/:path*");
    expect(h.has("Cache-Control")).toBe(false);
  });

  it("scopes the no-store rule to /api only", async () => {
    const sources = (await rules()).map((r) => r.source);

    expect(sources).toContain("/api/:path*");
    expect(sources.some((s) => s.includes("_next"))).toBe(false);
  });
});

describe("existing security headers are preserved", () => {
  it.each([
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["X-Frame-Options", "DENY"],
  ])("still sets %s", async (key, value) => {
    const h = await headersFor("/:path*");
    expect(h.get(key)).toBe(value);
  });

  it("still does not assert HSTS — NGINX owns that", async () => {
    const h = await headersFor("/:path*");
    expect(h.has("Strict-Transport-Security")).toBe(false);
  });
});
