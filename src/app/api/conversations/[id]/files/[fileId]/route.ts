import { requireActiveUser, isFailure } from "@/lib/files/guard";
import { detachFile } from "@/lib/ai/context/attachments";

/**
 * Detaches one file from one conversation.
 *
 * Removes the JOIN ROW ONLY. The File itself keeps its blob, its extracted text and its
 * place in the user's workspace, and any other conversation it is attached to is
 * unaffected. Detaching is not deleting.
 */

const ID_MAX_LENGTH = 64;

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string; fileId: string }> }
) {
  const guard = await requireActiveUser(req);
  if (isFailure(guard)) return guard.response;

  const { id, fileId } = await context.params;

  if (id.length > ID_MAX_LENGTH || fileId.length > ID_MAX_LENGTH) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const detached = await detachFile(guard.userId, id, fileId);

  if (!detached) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json({ detached: true });
}
