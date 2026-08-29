import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { assertRequiredBuildConfig } from "./src/lib/build-config";

/**
 * Application-owned security headers.
 *
 * Deliberately NOT set here:
 *   - Strict-Transport-Security — NGINX terminates TLS. This app is reached over plain
 *     HTTP on loopback and cannot know whether the client used TLS, so it must never
 *     assert HSTS.
 *
 * X-Frame-Options/frame-ancestors are safe to deny: the repository contains no iframe,
 * embed, or postMessage usage, and these headers govern whether OUR pages may be framed
 * — not whether Clerk may embed its own iframes into ours.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * The Clerk Frontend API origin, DERIVED from the publishable key rather than guessed.
 *
 * Clerk encodes its Frontend API host in the key itself: `pk_<env>_<base64>` where the
 * base64 decodes to "<host>$". @clerk/shared does exactly this (see parsePublishableKey
 * in node_modules/@clerk/shared/dist/keys.mjs), and clerk-js is then loaded from
 * `https://<host>/npm/@clerk/clerk-js@<version>/dist/clerk.browser.js`. Deriving it here
 * means the policy always matches the key actually baked into the bundle, and no Clerk
 * domain is invented.
 *
 * Returns null when the key is missing or malformed; the caller then omits the origin
 * rather than emitting a broken directive.
 */
function clerkFrontendApiOrigin(): string | null {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!key) return null;

  const encoded = key.split("_")[2];

  if (!encoded) return null;

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");

    if (!decoded.endsWith("$")) return null;

    const host = decoded.slice(0, -1);

    // Host-shaped only. Anything else would let a malformed key inject CSP syntax.
    if (!/^[a-z0-9.-]+$/i.test(host)) return null;

    return `https://${host}`;
  } catch {
    return null;
  }
}

/**
 * Content-Security-Policy.
 *
 * PHASE 3F SHIPS THIS AS REPORT-ONLY. Report-Only observes and reports; it blocks
 * nothing. The HIGH finding this addresses stays OPEN until the policy has been
 * validated in a browser and promoted to enforcing (CSP_ENFORCE=1).
 *
 * 'unsafe-inline' in script-src is REQUIRED by the current build, not a shortcut.
 * Next.js 16 emits the streaming RSC payload as bare inline <script> blocks with no
 * nonce and no hash — verified in this repository's own build output, where a
 * prerendered page contains two such blocks beginning `(self.__next_f=self.__next_f||
 * []).push(...)`. Removing 'unsafe-inline' requires nonce propagation through
 * middleware, which is a larger change than this phase's scope allows; it is the
 * prerequisite for enforcing mode.
 *
 * 'unsafe-inline' in style-src is required for the same structural reason: the build
 * emits inline style="..." attributes, and attribute styles cannot carry a nonce.
 *
 * 'unsafe-eval' is deliberately NOT included. Nothing has demonstrated a need for it;
 * if Report-Only shows one, that is a finding to review rather than a directive to add
 * pre-emptively.
 *
 * Third-party origins are limited to what this integration actually loads:
 *   - the Clerk Frontend API origin above (clerk-js, and its XHR/WebSocket traffic)
 *   - img.clerk.com / images.clerk.com — Clerk-hosted user avatars
 *   - challenges.cloudflare.com — Clerk's bot-protection (Turnstile) widget, referenced
 *     by the installed @clerk packages
 *   - clerk-telemetry.com — Clerk's telemetry endpoint, on by default
 * No wildcards are used.
 */
function contentSecurityPolicy(): string {
  const clerk = clerkFrontendApiOrigin();
  const clerkSrc = clerk ? ` ${clerk}` : "";

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-inline'${clerkSrc} https://challenges.cloudflare.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://img.clerk.com https://images.clerk.com",
    "font-src 'self' data:",
    `connect-src 'self'${clerkSrc} https://clerk-telemetry.com`,
    "worker-src 'self' blob:",
    `frame-src 'self'${clerkSrc} https://challenges.cloudflare.com`,
    "manifest-src 'self'",
  ].join("; ");
}

/**
 * Report-Only unless CSP_ENFORCE=1.
 *
 * Next resolves headers() at BUILD time into the routes manifest, so promoting to
 * enforcing is a rebuild-and-redeploy, not a runtime toggle. That is stated here so
 * nobody expects flipping an env var on a running container to take effect.
 */
function cspHeader() {
  return {
    key:
      process.env.CSP_ENFORCE === "1"
        ? "Content-Security-Policy"
        : "Content-Security-Policy-Report-Only",
    value: contentSecurityPolicy(),
  };
}

/**
 * Authenticated API responses must never be stored.
 *
 * /api/conversations and /api/conversations/[id] return private message content. With
 * no cache directive a browser may heuristically cache a 200, and any intermediary
 * cache added later (an NGINX proxy_cache, a CDN) would be free to store and replay an
 * authenticated response to a different user.
 *
 * Scoped to /api/:path* ONLY. Static assets under /_next/static keep their immutable
 * caching, which is what makes repeat page loads cheap.
 */
const noStoreHeaders = [
  { key: "Cache-Control", value: "no-store" },
];

const nextConfig: NextConfig = {
  // Produces .next/standalone with a minimal server.js and only the traced subset of
  // node_modules, so the runtime image carries no devDependencies and no Prisma CLI.
  // Note: standalone does NOT copy `public` or `.next/static` — the Dockerfile copies
  // both explicitly, or the app boots and serves unstyled pages.
  output: "standalone",

  // Next's file tracer can miss native assets. Prisma's query engine is exactly that
  // class: a musl-linked .node binary plus the generated client, loaded at runtime
  // through paths the tracer cannot follow statically. Without this the runner starts
  // and then fails on the first database call.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/.prisma/client/**/*",
      "./node_modules/@prisma/client/**/*",
    ],
  },

  // Stop advertising the framework and its version.
  poweredByHeader: false,

  async headers() {
    return [
      { source: "/:path*", headers: [...securityHeaders, cspHeader()] },
      { source: "/api/:path*", headers: noStoreHeaders },
    ];
  },
};

/**
 * The phase-aware form is used so the build-time gate runs ONLY during a production
 * build. `next.config.ts` is also evaluated by `next start`, and throwing there would
 * crash a running container over configuration it can no longer change — precisely the
 * crash-loop the readiness-based approach exists to avoid.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    assertRequiredBuildConfig();
  }

  return nextConfig;
}
