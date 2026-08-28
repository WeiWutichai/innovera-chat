import { logError } from "@/lib/log";
import { checkRequiredBuildConfig } from "@/lib/build-config";

export { checkRequiredBuildConfig, assertRequiredBuildConfig, REQUIRED_BUILD_VARS } from "@/lib/build-config";

/**
 * Validation of configuration that production genuinely cannot run without.
 *
 * Every function reads `process.env` at CALL time, never at module load. Tests
 * deliberately add and remove environment variables, and module-load caching would make
 * results depend on import order.
 *
 * Nothing here calls `process.exit()`. A hard exit under `restart: unless-stopped`
 * turns a configuration typo into a crash loop; failing readiness instead stops a
 * deployment before traffic moves while letting a running container degrade rather than
 * thrash.
 */

/** Required for the server to do its job at runtime. Absence fails readiness. */
export const REQUIRED_RUNTIME_VARS = [
  "DATABASE_URL",
  "CLERK_SECRET_KEY",
  "LITELLM_API_KEY",
  "LITELLM_BASE_URL",
] as const;

export type ConfigReport = {
  ok: boolean;
  /** Variable NAMES only. Values are never included, logged, or returned. */
  missing: string[];
};

function findMissing(names: readonly string[]): string[] {
  return names.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  });
}

/** Runtime configuration required before this instance should receive traffic. */
export function checkRequiredRuntimeConfig(): ConfigReport {
  const missing = findMissing(REQUIRED_RUNTIME_VARS);
  return { ok: missing.length === 0, missing };
}

/**
 * Logs missing configuration by NAME. Returns the report so callers can act on it.
 * Values are never read into the log — only membership of the missing list.
 */
export function reportRequiredConfig(): ConfigReport {
  const runtime = checkRequiredRuntimeConfig();
  const build = checkRequiredBuildConfig();

  if (!runtime.ok) {
    logError("config.missing_required_runtime", { variables: runtime.missing });
  }

  if (!build.ok) {
    logError("config.missing_required_build", { variables: build.missing });
  }

  return runtime;
}
