import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { fileConfig } from "@/lib/files/config";
import { getStorage } from "@/lib/files/storage/factory";
import {
  checkConsistency,
  contentDisposition,
  sanitizeFilename,
  sniff,
} from "@/lib/files/validate";
import { logError, logInfo, logWarn } from "@/lib/log";

export type UploadRejection =
  | "too_large"
  | "too_many"
  | "quota_exceeded"
  | "mime_mismatch"
  | "empty";

export type UploadOutcome =
  | { ok: true; id: string; filename: string; mimeType: string; sizeBytes: number }
  | { ok: false; filename: string; reason: UploadRejection };

/** Bytes the user currently occupies. The single source of truth for quota. */
export async function usedBytes(userId: string): Promise<number> {
  const agg = await prisma.file.aggregate({
    _sum: { sizeBytes: true },
    where: { userId },
  });
  return agg._sum.sizeBytes ?? 0;
}

/**
 * Stores one already-buffered file.
 *
 * Order is deliberate: every cheap rejection happens before a byte is written, and the
 * database row is created only after the blob is durably on disk. The failure that
 * matters is a row with no blob — a download that 500s forever — so the write happens
 * first and is cleaned up if the row cannot be created.
 */
export async function storeFile(
  userId: string,
  filename: string,
  buffer: Buffer,
  correlationId: string
): Promise<UploadOutcome> {
  const cfg = fileConfig();
  const safeName = sanitizeFilename(filename);

  if (buffer.length === 0) {
    return { ok: false, filename: safeName, reason: "empty" };
  }

  if (buffer.length > cfg.maxSizeBytes) {
    logWarn("file.upload_rejected", { correlationId, userId, reason: "too_large", sizeBytes: buffer.length });
    return { ok: false, filename: safeName, reason: "too_large" };
  }

  const sniffed = sniff(buffer, safeName);
  const consistency = checkConsistency(sniffed, safeName);

  if (!consistency.ok) {
    logWarn("file.upload_rejected", { correlationId, userId, reason: consistency.reason });
    return { ok: false, filename: safeName, reason: consistency.reason };
  }

  // 128 bits of randomness, hex-encoded. Deliberately not a UUID: hyphens would fail
  // the storage-key allowlist, and an opaque id keeps the key format decoupled from
  // whatever the database happens to use for primary keys.
  const fileId = randomBytes(16).toString("hex");
  const storageKey = `${userId}/${fileId}`;
  const storage = getStorage();

  // ---------------------------------------------------------------------------
  // ORDER: blob first, then the quota-checked row.
  //
  // The two failure states are not symmetrical. A ROW WITHOUT A BLOB is a file the
  // user can see and whose download fails forever, and it consumes quota. A BLOB
  // WITHOUT A ROW is invisible, consumes no quota (quota is computed from File rows
  // alone), and is reclaimable by a sweep. Writing the blob first means a crash at any
  // point leaves only the harmless kind.
  //
  // It also means no reservation table is needed, and therefore no expiry logic and no
  // phantom reservations to garbage-collect after a crash.
  // ---------------------------------------------------------------------------
  const written = await storage.put(storageKey, buffer);

  try {
    const row = await admitWithinQuota({
      userId,
      fileId,
      storageKey,
      filename: safeName,
      mimeType: sniffed.mimeType,
      sizeBytes: written.sizeBytes,
      checksum: written.checksum,
      quotaBytes: cfg.quotaBytes,
    });

    if (!row) {
      // Rejected by the atomic check. These bytes are referenced by nothing.
      await storage.delete(storageKey).catch(() => {
        logError("file.orphan_blob", { correlationId, fileId });
      });

      logWarn("file.upload_rejected", { correlationId, userId, reason: "quota_exceeded" });
      return { ok: false, filename: safeName, reason: "quota_exceeded" };
    }

    logInfo("file.uploaded", {
      correlationId,
      userId,
      fileId: row.id,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    });

    return { ok: true, ...row };
  } catch (error) {
    // The row could not be created, so nothing references these bytes. Leaving them
    // would consume disk that no listing can explain and no delete can reclaim.
    await storage.delete(storageKey).catch(() => {
      logError("file.orphan_blob", { correlationId, fileId });
    });
    throw error;
  }
}

type AdmissionInput = {
  userId: string;
  fileId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  quotaBytes: number;
};

/**
 * Atomically admits one file against the user's storage quota.
 *
 * ============================ CONCURRENCY STRATEGY ============================
 * A per-user PostgreSQL ROW LOCK, taken inside the same transaction that both measures
 * usage and inserts the row.
 *
 *   BEGIN
 *     SELECT id FROM "User" WHERE id = $1 FOR UPDATE   -- serialises this user only
 *     SELECT SUM("sizeBytes") FROM "File" WHERE "userId" = $1
 *     -- reject, or --
 *     INSERT INTO "File" ...
 *   COMMIT
 *
 * Reading the total and writing the row inside one lock is what makes the check
 * meaningful. Without the lock, two concurrent 25 MB uploads against 30 MB of remaining
 * quota both observe 30 MB free and both commit — 50 MB admitted. With it, the second
 * transaction blocks until the first commits, then measures 25 MB used and is refused.
 *
 * Why a row lock rather than the alternatives:
 *   - An in-memory mutex is wrong by construction: it holds only within one process, so
 *     the guarantee evaporates the moment a second replica exists. The correctness
 *     boundary has to live in the database.
 *   - Serializable isolation would also be correct, but it fails with a retryable
 *     conflict rather than waiting, so every caller needs retry logic. FOR UPDATE simply
 *     queues, which is the right shape for a short critical section.
 *   - A reservation table would need expiry, a sweeper, and crash reconciliation. The
 *     blob-first ordering above removes the need for one entirely.
 *
 * The lock is on the USER row, so different users never block each other — the only
 * contention is a single user uploading concurrently, which is exactly the race being
 * closed. The critical section contains no I/O beyond two indexed queries; the blob is
 * already on disk before the transaction opens.
 *
 * Returns null when the quota would be exceeded. Throws only on a real database error.
 * =============================================================================
 */
async function admitWithinQuota(input: AdmissionInput) {
  return prisma.$transaction(async (tx) => {
    // Locks this user's row for the remainder of the transaction. Any concurrent upload
    // for the same user waits here.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${input.userId} FOR UPDATE`;

    const agg = await tx.file.aggregate({
      _sum: { sizeBytes: true },
      where: { userId: input.userId },
    });

    const used = agg._sum.sizeBytes ?? 0;

    if (used + input.sizeBytes > input.quotaBytes) {
      return null;
    }

    return tx.file.create({
      data: {
        id: input.fileId,
        userId: input.userId,
        storageKey: input.storageKey,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        checksum: input.checksum,
      },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true },
    });
  });
}

/** Owner-scoped lookup. Returns null for another user's file — never a 403. */
export async function getOwnedFile(userId: string, fileId: string) {
  return prisma.file.findFirst({
    where: { id: fileId, userId },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      checksum: true,
      storageKey: true,
      extractStatus: true,
      extractReason: true,
      extractedText: true,
      extractedChars: true,
      extractTruncated: true,
      extractUnits: true,
      extractMetadata: true,
      extractedAt: true,
      createdAt: true,
    },
  });
}

export async function listOwnedFiles(userId: string) {
  return prisma.file.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      sizeBytes: true,
      extractStatus: true,
      extractReason: true,
      extractedChars: true,
      extractTruncated: true,
      createdAt: true,
    },
  });
}

/**
 * Deletes the row and the blob.
 *
 * The row goes first: a blob with no row is invisible and reclaimable by a sweep, while
 * a row with no blob is a download that fails forever. Storage delete is idempotent, so
 * a retry after a partial failure is safe.
 */
export async function deleteOwnedFile(
  userId: string,
  fileId: string,
  correlationId: string
): Promise<boolean> {
  const file = await getOwnedFile(userId, fileId);
  if (!file) return false;

  await prisma.file.delete({ where: { id: file.id } });

  try {
    await getStorage().delete(file.storageKey);
  } catch {
    logError("file.blob_delete_failed", { correlationId, fileId: file.id });
  }

  logInfo("file.deleted", { correlationId, userId, fileId: file.id });
  return true;
}

export { contentDisposition };
