import { prisma } from "@/lib/prisma";
import { checkRequiredRuntimeConfig } from "@/lib/required-config";
import { logError } from "@/lib/log";

// Readiness: should this instance receive traffic?
//
// Checks required runtime configuration and minimal database connectivity, with a
// bounded timeout so a hung database cannot make the probe hang too.
//
// LiteLLM is deliberately NOT checked. If the GPU backend is down this application can
// still serve conversation history, the admin panel and authentication, and returns a
// clean 502 for chat. Failing readiness would remove the whole app over a partial
// dependency — strictly worse for users. Upstream health is a monitoring signal.
//
// The response body never reveals why readiness failed; the reason goes to the log.
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 2000;

/**
 * Timeout semantics, stated precisely: this races the query against a timer and stops
 * WAITING after DB_TIMEOUT_MS. It does NOT cancel the PostgreSQL query — there is no
 * cancellation request sent, and the statement continues on its connection until it
 * completes or the connection drops.
 *
 * That is acceptable here only because the probe is `SELECT 1`: it is trivial, holds no
 * locks, and abandoning it leaks nothing meaningful. A heavier readiness query would
 * need a real server-side bound (statement_timeout) rather than a client-side race.
 */
async function databaseReachable(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS);
    });

    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch (error) {
    logError("health.database_unreachable", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  const config = checkRequiredRuntimeConfig();

  if (!config.ok) {
    // Variable NAMES only, and only to the log — never to the response body.
    logError("health.missing_required_config", { variables: config.missing });
    return Response.json({ ready: false }, { status: 503 });
  }

  if (!(await databaseReachable())) {
    return Response.json({ ready: false }, { status: 503 });
  }

  return Response.json({ ready: true });
}
