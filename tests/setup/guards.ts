/**
 * Safety guards. These exist to make it structurally impossible for the test suite to
 * touch production, not merely unlikely.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Rejects any database URL that is not loopback, and any URL identical to the
 * application's own DATABASE_URL.
 *
 * The production database is reached through DATABASE_URL, so refusing to equal it —
 * and refusing anything off-loopback — removes the two ways a test run could point at
 * production. GitHub Actions service containers are reachable on localhost, so CI is
 * unaffected. TEST_ALLOW_REMOTE_DB=1 is an explicit, deliberate escape hatch.
 */
export function assertSafeDatabaseUrl(url: string, source: string) {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[test-safety] ${source} is not a valid URL.`);
  }

  const appUrl = process.env.DATABASE_URL;

  if (appUrl && appUrl === url) {
    throw new Error(
      `[test-safety] ${source} is identical to DATABASE_URL. Tests must never run ` +
        `against the application's own database. Point TEST_DATABASE_URL at a ` +
        `throwaway database instead.`
    );
  }

  if (!LOOPBACK.has(parsed.hostname) && process.env.TEST_ALLOW_REMOTE_DB !== "1") {
    throw new Error(
      `[test-safety] ${source} points at "${parsed.hostname}", which is not loopback. ` +
        `Refusing to run. Set TEST_ALLOW_REMOTE_DB=1 only if you are certain this is ` +
        `a disposable database.`
    );
  }
}

/**
 * The upstream base URL is always an ephemeral local server started by the tests. This
 * guard rejects anything else so a stray environment variable cannot send test traffic
 * at the real LiteLLM/vLLM deployment.
 */
export function assertLocalUpstream(baseUrl: string) {
  const parsed = new URL(baseUrl);

  if (!LOOPBACK.has(parsed.hostname)) {
    throw new Error(
      `[test-safety] Upstream base URL "${baseUrl}" is not loopback. Tests must never ` +
        `contact the real LiteLLM/vLLM backend.`
    );
  }
}
