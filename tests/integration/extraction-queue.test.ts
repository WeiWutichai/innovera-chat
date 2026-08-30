import { describe, it, expect, beforeEach, afterEach, inject } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { __resetStorage } from "@/lib/files/storage/factory";
import { claimNext, processNext, sweep, __testing } from "@/lib/extraction/queue";
import * as fx from "../setup/fixtures";

const databaseUrl = inject("databaseUrl");

let root: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();

  root = mkdtempSync(path.join(os.tmpdir(), "m2-queue-"));
  process.env.FILE_STORAGE_ROOT = root;
  __resetStorage();

  const user = await seedUser({ clerkUserId: "ck_q", email: "q@test.local" });
  userId = user.id;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FILE_STORAGE_ROOT;
  __resetStorage();
});

/** Creates a File row plus its blob, exactly as an upload would. */
async function seedFile(opts: {
  filename: string;
  mimeType: string;
  content: Buffer;
  status?: "PENDING" | "PROCESSING" | "EXTRACTED" | "SKIPPED";
  leaseUntil?: Date | null;
  attempts?: number;
}) {
  const fileId = Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
  const storageKey = `${userId}/${fileId}`;

  mkdirSync(path.join(root, userId), { recursive: true });
  writeFileSync(path.join(root, storageKey), opts.content);

  return prisma.file.create({
    data: {
      id: fileId,
      userId,
      storageKey,
      filename: opts.filename,
      mimeType: opts.mimeType,
      sizeBytes: opts.content.length,
      checksum: "x".repeat(64),
      extractStatus: opts.status ?? "PENDING",
      extractLeaseUntil: opts.leaseUntil ?? null,
      extractAttempts: opts.attempts ?? 0,
    },
  });
}

describe("PENDING -> PROCESSING -> terminal", () => {
  it("moves a text file to EXTRACTED", async () => {
    const file = await seedFile({
      filename: "a.txt",
      mimeType: "text/plain",
      content: Buffer.from("hello extraction"),
    });

    expect(await processNext()).toBe(true);

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.extractStatus).toBe("EXTRACTED");
    expect(after.extractedText).toBe("hello extraction");
    expect(after.extractedChars).toBe(16);
    expect(after.extractedAt).not.toBeNull();
    // The lease must be released, or the row looks perpetually in flight.
    expect(after.extractLeaseUntil).toBeNull();
  });

  it("claims a row into PROCESSING with a lease before parsing", async () => {
    await seedFile({ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("x") });

    const claimed = await claimNext();
    expect(claimed).not.toBeNull();

    const row = await prisma.file.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(row.extractStatus).toBe("PROCESSING");
    expect(row.extractLeaseUntil).not.toBeNull();
    expect(row.extractAttempts).toBe(1);
  });

  it("records UNSUPPORTED for an image, with dimensions", async () => {
    const file = await seedFile({
      filename: "a.png",
      mimeType: "image/png",
      content: fx.png(120, 80),
    });

    await processNext();

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.extractStatus).toBe("UNSUPPORTED");
    expect(after.extractReason).toMatch(/cannot read image content/i);
    expect(after.extractMetadata).toMatchObject({ width: 120, height: 80 });
  });

  it("records PARTIAL with the pre-truncation character count", async () => {
    const file = await seedFile({
      filename: "big.csv",
      mimeType: "text/plain",
      content: Buffer.from(Array.from({ length: 6000 }, (_, i) => `${i},x`).join("\n")),
    });

    await processNext();

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.extractStatus).toBe("PARTIAL");
    expect(after.extractReason).toBeTruthy();
  });

  it("records units for a workbook", async () => {
    const file = await seedFile({
      filename: "b.xlsx",
      mimeType: "application/zip",
      content: fx.xlsx([{ name: "One", rows: [["a"]] }, { name: "Two", rows: [["b"]] }]),
    });

    await processNext();

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.extractStatus).toBe("EXTRACTED");
    expect(after.extractUnits).toHaveLength(2);
  });

  it("returns false when there is nothing to claim", async () => {
    expect(await processNext()).toBe(false);
  });

  it("never picks up a SKIPPED M1 file", async () => {
    // M1 files were stored before extraction existed. Re-interpreting them silently
    // would change what a user sees for a file they uploaded under different rules.
    const file = await seedFile({
      filename: "legacy.txt",
      mimeType: "text/plain",
      content: Buffer.from("legacy"),
      status: "SKIPPED",
    });

    expect(await processNext()).toBe(false);

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.extractStatus).toBe("SKIPPED");
  });
});

describe("duplicate claims", () => {
  it("never hands the same row to two concurrent claimers", async () => {
    await seedFile({ filename: "only.txt", mimeType: "text/plain", content: Buffer.from("x") });

    // Separate clients so the two claims cannot share a connection.
    const a = new PrismaClient({ datasourceUrl: databaseUrl });
    const b = new PrismaClient({ datasourceUrl: databaseUrl });

    try {
      const [first, second] = await Promise.all([claimNext(), claimNext()]);
      const claimed = [first, second].filter(Boolean);

      // FOR UPDATE SKIP LOCKED: one takes the row, the other finds nothing.
      expect(claimed).toHaveLength(1);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it("gives concurrent claimers different rows when several are pending", async () => {
    await seedFile({ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("a") });
    await seedFile({ filename: "b.txt", mimeType: "text/plain", content: Buffer.from("b") });

    const [first, second] = await Promise.all([claimNext(), claimNext()]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
  });

  it("does not re-claim a row whose lease is still live", async () => {
    const future = new Date(Date.now() + 60_000);
    await seedFile({
      filename: "busy.txt",
      mimeType: "text/plain",
      content: Buffer.from("x"),
      status: "PROCESSING",
      leaseUntil: future,
    });

    // A long extraction is not an abandoned one.
    expect(await claimNext()).toBeNull();
  });
});

describe("crash recovery", () => {
  it("reclaims a PROCESSING row whose lease has expired", async () => {
    const stranded = await seedFile({
      filename: "stranded.txt",
      mimeType: "text/plain",
      content: Buffer.from("recovered content"),
      status: "PROCESSING",
      leaseUntil: new Date(Date.now() - 60_000),
      attempts: 1,
    });

    const claimed = await claimNext();
    expect(claimed?.id).toBe(stranded.id);

    await processNext();
  });

  it("drives a stranded row all the way to a terminal state", async () => {
    const stranded = await seedFile({
      filename: "stranded.txt",
      mimeType: "text/plain",
      content: Buffer.from("recovered content"),
      status: "PROCESSING",
      leaseUntil: new Date(Date.now() - 60_000),
    });

    await sweep();

    const after = await prisma.file.findUniqueOrThrow({ where: { id: stranded.id } });
    expect(after.extractStatus).toBe("EXTRACTED");
    expect(after.extractedText).toBe("recovered content");
  });

  it("leaves no row permanently in PROCESSING after a sweep", async () => {
    await seedFile({ filename: "a.txt", mimeType: "text/plain", content: Buffer.from("a") });
    await seedFile({
      filename: "b.txt",
      mimeType: "text/plain",
      content: Buffer.from("b"),
      status: "PROCESSING",
      leaseUntil: new Date(Date.now() - 1),
    });

    await sweep();

    const stuck = await prisma.file.count({ where: { extractStatus: "PROCESSING" } });
    expect(stuck).toBe(0);
  });

  it("fails a row permanently once attempts are exhausted", async () => {
    // Otherwise a file that reliably crashes the parser cycles forever.
    const file = await seedFile({
      filename: "cursed.txt",
      mimeType: "text/plain",
      content: Buffer.from("x"),
      attempts: __testing.MAX_ATTEMPTS,
    });

    await processNext();

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.extractStatus).toBe("FAILED");
    expect(after.extractReason).toMatch(/repeated attempts/i);
    expect(after.extractLeaseUntil).toBeNull();
  });

  it("reaches FAILED, not PROCESSING, when the blob is missing", async () => {
    const file = await seedFile({
      filename: "gone.txt",
      mimeType: "text/plain",
      content: Buffer.from("x"),
    });

    // Simulate storage loss beneath a healthy database.
    rmSync(path.join(root, file.storageKey), { force: true });

    await processNext();

    const after = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.extractStatus).toBe("FAILED");
    expect(after.extractLeaseUntil).toBeNull();
  });
});

describe("sweep bounds", () => {
  it("processes at most the batch limit in one pass", async () => {
    for (let i = 0; i < __testing.SWEEP_BATCH + 3; i++) {
      await seedFile({ filename: `f${i}.txt`, mimeType: "text/plain", content: Buffer.from(`c${i}`) });
    }

    // A request-triggered sweep must not turn one page load into unbounded work.
    const processed = await sweep();
    expect(processed).toBe(__testing.SWEEP_BATCH);

    const remaining = await prisma.file.count({ where: { extractStatus: "PENDING" } });
    expect(remaining).toBe(3);
  });

  it("stops early when the queue drains", async () => {
    await seedFile({ filename: "one.txt", mimeType: "text/plain", content: Buffer.from("x") });
    expect(await sweep()).toBe(1);
  });

  it("processes oldest first", async () => {
    const first = await seedFile({ filename: "old.txt", mimeType: "text/plain", content: Buffer.from("old") });
    await new Promise((r) => setTimeout(r, 10));
    await seedFile({ filename: "new.txt", mimeType: "text/plain", content: Buffer.from("new") });

    const claimed = await claimNext();
    expect(claimed?.id).toBe(first.id);
  });
});
