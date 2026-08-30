import { fileConfig } from "@/lib/files/config";
import { requireActiveUser, isFailure } from "@/lib/files/guard";
import { storeFile, listOwnedFiles, usedBytes, type UploadOutcome } from "@/lib/files/service";
import { checkUploadRateLimit } from "@/lib/rate-limiter";
import { logWarn } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requireActiveUser(req);
  if (isFailure(guard)) return guard.response;

  const cfg = fileConfig();
  const [files, used] = await Promise.all([
    listOwnedFiles(guard.userId),
    usedBytes(guard.userId),
  ]);

  return Response.json({
    files,
    quota: { usedBytes: used, limitBytes: cfg.quotaBytes },
  });
}

export async function POST(req: Request) {
  const correlationId = crypto.randomUUID().slice(0, 8);

  const guard = await requireActiveUser(req);
  if (isFailure(guard)) return guard.response;

  const cfg = fileConfig();

  // Cheapest rejection first, before the multipart body is read — the same ordering
  // /api/chat uses. Parsing a 250 MB body only to rate-limit it afterwards would make
  // the limiter an amplifier rather than a protection.
  const rate = checkUploadRateLimit(guard.userId, cfg.uploadsPerMinute);

  if (!rate.allowed) {
    logWarn("file.rate_limited", { correlationId, userId: guard.userId });
    return Response.json(
      { error: "Too many uploads. Please wait.", reason: "rate_limited", correlationId },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
    );
  }

  let form: FormData;

  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Invalid upload" }, { status: 400 });
  }

  const entries = form.getAll("files").filter((v): v is File => v instanceof File);

  if (entries.length === 0) {
    return Response.json({ error: "No files provided" }, { status: 400 });
  }

  if (entries.length > cfg.maxPerUpload) {
    logWarn("file.upload_rejected", { correlationId, userId: guard.userId, reason: "too_many" });
    return Response.json(
      { error: `At most ${cfg.maxPerUpload} files per upload`, reason: "too_many" },
      { status: 400 }
    );
  }

  // Aggregate payload cap, evaluated from declared sizes BEFORE a single byte is read
  // into the heap and before any blob is written.
  //
  // Per-file and per-count limits alone are not sufficient: 10 files x 25 MB is 250 MB
  // in one request, which on a single-replica container competing with AI generation is
  // enough to matter. Declared sizes are client-supplied and therefore not trusted as
  // truth — but a client that UNDER-declares only shrinks its own admission, and each
  // file's real length is still checked individually below.
  const declaredTotal = entries.reduce((sum, entry) => sum + entry.size, 0);

  if (declaredTotal > cfg.maxBatchBytes) {
    logWarn("file.upload_rejected", {
      correlationId,
      userId: guard.userId,
      reason: "batch_too_large",
      declaredBytes: declaredTotal,
    });

    return Response.json(
      {
        error: `Total upload size must not exceed ${cfg.maxBatchMb} MB`,
        reason: "batch_too_large",
      },
      { status: 413 }
    );
  }

  // Size is checked from the declared size BEFORE buffering, so an oversized file is
  // rejected without ever being pulled fully into memory. storeFile re-checks the real
  // byte length, because the declared size is client-supplied.
  const results: UploadOutcome[] = [];

  for (const entry of entries) {
    if (entry.size > cfg.maxSizeBytes) {
      results.push({ ok: false, filename: entry.name, reason: "too_large" });
      continue;
    }

    const buffer = Buffer.from(await entry.arrayBuffer());
    results.push(await storeFile(guard.userId, entry.name, buffer, correlationId));
  }

  const accepted = results.filter((r) => r.ok).length;

  // 207 when the batch is mixed: a blanket 200 would hide per-file rejections, and a
  // blanket 400 would discard files that stored successfully.
  return Response.json(
    { results, accepted, rejected: results.length - accepted, correlationId },
    { status: accepted === results.length ? 201 : accepted === 0 ? 400 : 207 }
  );
}
