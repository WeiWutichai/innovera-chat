import { Readable } from "node:stream";
import { requireActiveUser, isFailure } from "@/lib/files/guard";
import { getOwnedFile, contentDisposition } from "@/lib/files/service";
import { getStorage } from "@/lib/files/storage/factory";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Download.
 *
 * Every header here is deliberate:
 *   Content-Type        the SNIFFED type, never the client's claim
 *   Content-Disposition always attachment — inline HTML/SVG from our own origin would
 *                       execute as same-origin script
 *   X-Content-Type-Options  nosniff, so the browser cannot override us
 *   Cache-Control       no-store; this is private, authenticated content
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const correlationId = crypto.randomUUID().slice(0, 8);

  const guard = await requireActiveUser(req);
  if (isFailure(guard)) return guard.response;

  const { id } = await context.params;
  const file = await getOwnedFile(guard.userId, id);

  if (!file) return Response.json({ error: "File not found" }, { status: 404 });

  let stream: Readable;

  try {
    stream = await getStorage().get(file.storageKey);
  } catch {
    // Row exists but the blob does not. Reported as 404 rather than 500: from the
    // caller's perspective the file is unavailable, and the internal inconsistency
    // belongs in the log, not the response.
    logError("file.blob_missing", { correlationId, fileId: file.id });
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.sizeBytes),
      "Content-Disposition": contentDisposition(file.filename),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
