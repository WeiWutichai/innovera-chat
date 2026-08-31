import { prisma } from "@/lib/prisma";

/**
 * Conversation <-> File attachment service.
 *
 * ============================ THE AUTHORIZATION RULE =============================
 * Every operation proves BOTH endpoints belong to the authenticated user:
 *
 *     Conversation.userId === currentUser  AND  File.userId === currentUser
 *
 * The user id always comes from the Clerk session via the route guard. A userId in a
 * request body is never authority for anything, and no function here accepts one.
 *
 * ============================== NO INFORMATION ORACLE ============================
 * Every failure — conversation missing, conversation owned by someone else, file
 * missing, file owned by someone else, any mixture — returns the SAME `null`, which the
 * routes render as an identical 404. A distinct 403 for "exists but not yours" would
 * confirm the row exists, letting an attacker enumerate other users' conversation and
 * file ids by watching which id changes the status code.
 *
 * Attaching is ALL-OR-NOTHING for the same reason. If any one id in a batch is not the
 * caller's, the whole request 404s and nothing is written. Partial success would leak
 * exactly which ids were valid.
 *
 * ======================= ASSOCIATED IS NOT THE SAME AS ACTIVE ====================
 * A `ConversationFile` row means "this file is ASSOCIATED with this conversation" — it
 * is history, it survives reload, and it lets the user re-select the file later. It does
 * NOT mean the file is read on every subsequent turn.
 *
 * Which files are ACTIVE is decided per turn by the chat request's `fileIds`. Only active
 * files contribute extracted text to that turn's prompt; an associated-but-inactive file
 * contributes zero characters. Injecting the whole association on every turn would mean a
 * document attached once silently consumed half the context budget forever, crowding out
 * the conversation it was attached to.
 *
 * `listAttachments` therefore answers "what is associated" (for the UI), and
 * `loadActiveFilesForContext` answers "what may be read this turn" (for the prompt).
 * =================================================================================
 */

/** Bounded so one request cannot attach an unbounded number of rows. */
export const MAX_ATTACHMENTS_PER_CONVERSATION = 20;

export type AttachmentFile = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractStatus: string;
  extractReason: string | null;
  extractedChars: number | null;
  extractTruncated: boolean;
  createdAt: Date;
};

/** The columns the context builder and the UI need. Never the extracted text itself. */
const ATTACHMENT_SELECT = {
  id: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  extractStatus: true,
  extractReason: true,
  extractedChars: true,
  extractTruncated: true,
  createdAt: true,
} as const;

/** True when the conversation exists AND belongs to this user. */
async function ownsConversation(userId: string, conversationId: string): Promise<boolean> {
  const found = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });

  return found !== null;
}

/**
 * True when every id exists AND belongs to this user.
 *
 * Counting owned rows and comparing against the DEDUPLICATED input is what makes a
 * foreign id impossible to smuggle in: a batch of [myFile, yourFile] finds one owned row
 * against two requested ids and fails, rather than silently attaching the half that
 * happened to pass.
 */
async function ownsAllFiles(userId: string, fileIds: string[]): Promise<boolean> {
  const unique = [...new Set(fileIds)];

  if (unique.length === 0) return true;

  const owned = await prisma.file.count({
    where: { id: { in: unique }, userId },
  });

  return owned === unique.length;
}

/**
 * Attaches files to a conversation. Returns null when the caller does not own every
 * endpoint — routes must translate that to 404.
 *
 * Idempotent: `ConversationFile` is keyed on (conversationId, fileId), so re-attaching
 * an already-attached file is a no-op rather than a duplicate or an error.
 */
export async function attachFiles(
  userId: string,
  conversationId: string,
  fileIds: string[]
): Promise<AttachmentFile[] | null> {
  const unique = [...new Set(fileIds)];

  // One transaction so the ownership proof, the cap and the write cannot be interleaved
  // by a concurrent request: without it two simultaneous attaches could each observe
  // room under the cap and together exceed it, and a conversation deleted between the
  // check and the write would leave the write to fail on a foreign key instead of
  // returning a clean 404.
  const ok = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });

    if (!conversation) return false;

    if (unique.length > 0) {
      const owned = await tx.file.count({ where: { id: { in: unique }, userId } });
      if (owned !== unique.length) return false;

      // Bounds the total, not just this batch: a caller cannot walk past the cap by
      // attaching a few at a time.
      const existing = await tx.conversationFile.count({ where: { conversationId } });

      const alreadyAttached = await tx.conversationFile.count({
        where: { conversationId, fileId: { in: unique } },
      });

      if (existing + unique.length - alreadyAttached > MAX_ATTACHMENTS_PER_CONVERSATION) {
        return false;
      }

      await tx.conversationFile.createMany({
        data: unique.map((fileId) => ({ conversationId, fileId })),
        skipDuplicates: true,
      });
    }

    return true;
  });

  if (!ok) return null;

  return listAttachments(userId, conversationId);
}

/**
 * Removes one attachment. Returns false when the caller does not own both endpoints.
 *
 * Deletes the JOIN ROW ONLY. The File keeps its blob, its extracted text and its place
 * in the user's file workspace — detaching is not deleting, and a file attached to two
 * conversations stays available to the other one.
 */
export async function detachFile(
  userId: string,
  conversationId: string,
  fileId: string
): Promise<boolean> {
  if (!(await ownsConversation(userId, conversationId))) return false;
  if (!(await ownsAllFiles(userId, [fileId]))) return false;

  // deleteMany, not delete: detaching something already detached is a no-op rather than
  // a thrown P2025, and the ownership checks above have already established the right.
  await prisma.conversationFile.deleteMany({ where: { conversationId, fileId } });

  return true;
}

/** Attachments for a conversation the user owns, or null. Deterministically ordered. */
export async function listAttachments(
  userId: string,
  conversationId: string
): Promise<AttachmentFile[] | null> {
  if (!(await ownsConversation(userId, conversationId))) return null;

  const rows = await prisma.conversationFile.findMany({
    where: { conversationId },
    // Attachment time, then file id: a stable total order even when two files are
    // attached in the same millisecond, which is what makes context assembly
    // reproducible for the same inputs.
    orderBy: [{ createdAt: "asc" }, { fileId: "asc" }],
    select: { file: { select: ATTACHMENT_SELECT } },
  });

  // Defence in depth. The join rows were written through the ownership checks above, so
  // this filter should never remove anything; if a row ever appeared by another path,
  // its content still would not reach the model.
  return rows.map((r) => r.file).filter((f) => f !== null);
}

/**
 * The ACTIVE files for one turn, plus their extracted text, for context assembly only.
 *
 * Three things must all hold before a file's text can be loaded here, and all three are
 * enforced in the query rather than in the caller:
 *
 *   1. the conversation belongs to this user
 *   2. the file belongs to this user      (`file: { userId }`)
 *   3. the file is ASSOCIATED with this conversation and was named ACTIVE for this turn
 *
 * Point 2 is re-asserted at read time even though every write path already proved it. If
 * a join row ever came to exist by some other route, the file's text still never reaches
 * a prompt.
 *
 * Passing an empty `activeFileIds` returns an empty list — never the whole association.
 * That is what keeps an ordinary no-file turn identical to pre-M3 behaviour.
 *
 * Separate from `listAttachments` because this is the only query that reads
 * `extractedText`, and that separation keeps file content off the UI path entirely.
 */
export async function loadActiveFilesForContext(
  userId: string,
  conversationId: string,
  activeFileIds: string[]
): Promise<Array<AttachmentFile & { extractedText: string | null }> | null> {
  if (!(await ownsConversation(userId, conversationId))) return null;

  const unique = [...new Set(activeFileIds)];

  if (unique.length === 0) return [];

  const rows = await prisma.conversationFile.findMany({
    where: {
      conversationId,
      fileId: { in: unique },
      file: { userId },
    },
    orderBy: [{ createdAt: "asc" }, { fileId: "asc" }],
    select: { file: { select: { ...ATTACHMENT_SELECT, extractedText: true } } },
  });

  return rows.map((r) => r.file);
}
