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

  return Response.json({
    file: {
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      checksum: file.checksum,
      extractStatus: file.extractStatus,
      createdAt: file.createdAt,
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
