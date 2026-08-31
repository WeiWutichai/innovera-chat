import { z } from "zod";
import { requireActiveUser, isFailure } from "@/lib/files/guard";
import {
  attachFiles,
  listAttachments,
  MAX_ATTACHMENTS_PER_CONVERSATION,
} from "@/lib/ai/context/attachments";
import { logWarn } from "@/lib/log";

/**
 * Attachment collection for one conversation.
 *
 * Gate order is `requireActiveUser`, exactly as /api/files and /api/chat use:
 * cross-site -> auth -> ACTIVE user. Ownership of both endpoints is then proven inside
 * the attachment service, which returns the same null for every failure so the response
 * is an identical 404 whether the id was missing or simply someone else's.
 */

const ID_MAX_LENGTH = 64;

const attachSchema = z.object({
  fileIds: z
    .array(z.string().min(1).max(ID_MAX_LENGTH))
    .min(1)
    .max(MAX_ATTACHMENTS_PER_CONVERSATION),
});

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireActiveUser(req);
  if (isFailure(guard)) return guard.response;

  const { id } = await context.params;

  if (id.length > ID_MAX_LENGTH) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const attachments = await listAttachments(guard.userId, id);

  if (attachments === null) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  return Response.json({ attachments });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireActiveUser(req);
  if (isFailure(guard)) return guard.response;

  const { id } = await context.params;

  if (id.length > ID_MAX_LENGTH) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  let rawBody: unknown;

  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = attachSchema.safeParse(rawBody);

  if (!parsed.success) {
    return Response.json({ error: "Invalid file selection" }, { status: 400 });
  }

  const attachments = await attachFiles(guard.userId, id, parsed.data.fileIds);

  if (attachments === null) {
    // Deliberately indistinguishable from "no such conversation". Logged by id count
    // only — never the ids themselves, and never a filename.
    logWarn("conversation.attach_rejected", {
      userId: guard.userId,
      requested: parsed.data.fileIds.length,
    });

    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  return Response.json({ attachments }, { status: 201 });
}
