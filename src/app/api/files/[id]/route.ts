import { requireActiveUser, isFailure } from "@/lib/files/guard";
import { getOwnedFile, deleteOwnedFile } from "@/lib/files/service";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guard = await requireActiveUser(req);
  if (isFailure(guard)) return guard.response;

  const { id } = await context.params;
  const file = await getOwnedFile(guard.userId, id);

  // 404, never 403. A 403 would confirm that the id exists and belongs to somebody,
  // which is an enumeration oracle.
  if (!file) return Response.json({ error: "File not found" }, { status: 404 });

  // The preview is bounded independently of what was extracted: the stored text may be
  // 400k characters, and shipping that to a browser panel helps nobody.
  const PREVIEW_CHARS = 20_000;
  const text = file.extractedText ?? null;

  return Response.json({
    file: {
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      checksum: file.checksum,
      createdAt: file.createdAt,

      extractStatus: file.extractStatus,
      extractReason: file.extractReason,
      extractedChars: file.extractedChars,
      extractTruncated: file.extractTruncated,
      extractedAt: file.extractedAt,
      units: file.extractUnits ?? null,
      metadata: file.extractMetadata ?? null,

      preview: text === null ? null : text.slice(0, PREVIEW_CHARS),
      previewTruncated: text !== null && text.length > PREVIEW_CHARS,
    },
  });
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const correlationId = crypto.randomUUID().slice(0, 8);

  const guard = await requireActiveUser(req);
  if (isFailure(guard)) return guard.response;

  const { id } = await context.params;
  const deleted = await deleteOwnedFile(guard.userId, id, correlationId);

  if (!deleted) return Response.json({ error: "File not found" }, { status: 404 });

  return Response.json({ deleted: true });
}
