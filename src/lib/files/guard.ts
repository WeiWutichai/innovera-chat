import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export type GuardFailure = { response: Response };
export type GuardSuccess = { userId: string };

/**
 * The gate order used by every /api/files route, mirroring /api/chat exactly:
 * cross-site -> auth -> ACTIVE user. Identity is always taken from Clerk; a userId in
 * a request body is never authority for anything.
 *
 * Returns either the resolved application user id or the Response to send.
 */
export async function requireActiveUser(
  req: Request
): Promise<GuardSuccess | GuardFailure> {
  if (isCrossSiteRequest(req)) {
    return { response: Response.json({ error: "Forbidden" }, { status: 403 }) };
  }

  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    return { response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkUserId },
    select: { id: true, status: true },
  });

  if (!appUser || appUser.status !== "ACTIVE") {
    return { response: Response.json({ error: "Account is not active" }, { status: 403 }) };
  }

  return { userId: appUser.id };
}

/**
 * Same policy as /api/chat: Sec-Fetch-Site is primary; the Origin fallback compares
 * against APP_CANONICAL_ORIGIN when configured and never trusts X-Forwarded-Host.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");

  if (site) return site !== "same-origin" && site !== "none";

  const configured = process.env.APP_CANONICAL_ORIGIN?.trim();
  const origin = req.headers.get("origin");

  if (configured) {
    let canonical: string;
    try {
      const url = new URL(configured);
      if (url.protocol !== "https:" && url.protocol !== "http:") return true;
      canonical = url.origin;
    } catch {
      // Configured but unusable: refuse rather than silently downgrade to the weaker
      // Host comparison the operator did not choose.
      return true;
    }

    if (!origin) return false;

    try {
      return new URL(origin).origin !== canonical;
    } catch {
      return true;
    }
  }

  if (!origin) return false;

  const host = req.headers.get("host");
  if (!host) return false;

  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function isFailure(r: GuardSuccess | GuardFailure): r is GuardFailure {
  return "response" in r;
}
