/**
 * Build-time configuration validation.
 *
 * Kept dependency-free on purpose: `next.config.ts` is evaluated outside the application
 * module graph, so the `@/` alias is unavailable there and anything this file imports
 * would have to resolve from the config loader too.
 *
 * Reads `process.env` at call time — never at module load — so tests that add and remove
 * variables cannot become order-dependent.
 */

export const REQUIRED_BUILD_VARS = ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] as const;

export type BuildConfigReport = {
  ok: boolean;
  /** Variable NAMES only. Values are never included or surfaced. */
  missing: string[];
};

export function checkRequiredBuildConfig(): BuildConfigReport {
  const missing = REQUIRED_BUILD_VARS.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  });

  return { ok: missing.length === 0, missing };
}

/**
 * Throws when a required build-time variable is missing or blank.
 *
 * `NEXT_PUBLIC_*` values are inlined into the client bundle at build time. Without this
 * gate a build with the variable unset succeeds and bakes an EMPTY Clerk publishable key
 * into the bundle — producing an image that deploys cleanly and then cannot sign anyone
 * in, with no server-side symptom. Failing the build is the only place this is cheap to
 * catch.
 *
 * The message names the variable and never its value.
 */
export function assertRequiredBuildConfig(): void {
  const report = checkRequiredBuildConfig();

  if (report.ok) return;

  throw new Error(
    `Missing required build-time configuration: ${report.missing.join(", ")}. ` +
      `These values are inlined into the client bundle at build time, so the build is ` +
      `failing rather than shipping an empty value.`
  );
}
