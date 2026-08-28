import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { assertRequiredBuildConfig } from "./src/lib/build-config";

/**
 * Application-owned security headers only.
 *
 * Deliberately NOT set here:
 *   - Strict-Transport-Security — NGINX terminates TLS. This app is reached over plain
 *     HTTP on loopback and cannot know whether the client used TLS, so it must never
 *     assert HSTS.
 *   - Content-Security-Policy — Clerk injects scripts and workers from its own origins,
 *     and browsers enforce the INTERSECTION of every CSP received. A second policy from
 *     NGINX would silently break sign-in. A CSP needs confirmation that NGINX sends
 *     none, then a Report-Only period, and is out of scope for this phase.
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
    return [{ source: "/:path*", headers: securityHeaders }];
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
