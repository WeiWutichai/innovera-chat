import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { GET as listFiles, POST as uploadFiles } from "@/app/api/files/route";
import { actingAs, signedOut } from "../setup/clerk";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { __resetLimiters } from "@/lib/rate-limiter";
import { __resetStorage } from "@/lib/files/storage/factory";

let root: string;

const USER = { userId: "ck_files", email: "files@test.local" };

beforeEach(async () => {
  await resetDatabase();
  __resetLimiters();

  root = mkdtempSync(path.join(os.tmpdir(), "m1-int-"));
  process.env.FILE_STORAGE_ROOT = root;
  __resetStorage();

  await seedUser({ clerkUserId: USER.userId, email: USER.email, status: "ACTIVE" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FILE_STORAGE_ROOT;
  delete process.env.FILE_MAX_SIZE_MB;
  delete process.env.FILE_MAX_PER_UPLOAD;
  delete process.env.FILE_STORAGE_QUOTA_MB;
  delete process.env.FILE_MAX_BATCH_MB;
  __resetStorage();
});

/** Multipart request shaped exactly like the browser sends. */
function uploadRequest(files: Array<{ name: string; content: Buffer | string }>) {
  const form = new FormData();

  for (const f of files) {
    const bytes = typeof f.content === "string" ? Buffer.from(f.content) : f.content;
    // new Uint8Array(...) rather than the Buffer directly: BlobPart requires an
    // ArrayBuffer-backed view, and Buffer's type is not assignable to it.
    form.append("files", new File([new Uint8Array(bytes)], f.name));
  }

  return new Request("http://localhost:3000/api/files", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
    body: form,
  });
}

function listRequest() {
  return new Request("http://localhost:3000/api/files", {
    headers: { "sec-fetch-site": "same-origin" },
  });
}

/** Objects physically on disk, ignoring directory entries. */
function blobsOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

describe("successful upload", () => {
  it("stores one file and returns 201", async () => {
    const res = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "notes.txt", content: "hello" }]))
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(body.results[0]).toMatchObject({ ok: true, filename: "notes.txt" });

    expect(await prisma.file.count()).toBe(1);
    expect(blobsOnDisk()).toHaveLength(1);
  });

  it("records the sniffed type, not a client-supplied one", async () => {
    await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "notes.txt", content: "plain text" }]))
    );

    const row = await prisma.file.findFirstOrThrow();
    expect(row.mimeType).toBe("text/plain");
  });

  it("records a checksum and the true byte length", async () => {
    await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "a.txt", content: "1234567890" }]))
    );

    const row = await prisma.file.findFirstOrThrow();
    expect(row.sizeBytes).toBe(10);
    expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stores multiple files in one request", async () => {
    const res = await actingAs(USER, () =>
      uploadFiles(
        uploadRequest([
          { name: "a.txt", content: "a" },
          { name: "b.txt", content: "b" },
          { name: "c.txt", content: "c" },
        ])
      )
    );

    expect(res.status).toBe(201);
    expect((await res.json()).accepted).toBe(3);
    expect(await prisma.file.count()).toBe(3);
  });

  it("generates a storage key that never contains the filename", async () => {
    await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "../../etc/passwd", content: "x" }]))
    );

    const row = await prisma.file.findFirstOrThrow();
    expect(row.storageKey).not.toContain("passwd");
    expect(row.storageKey).not.toContain("..");
    expect(row.storageKey).toMatch(/^[a-z0-9]+\/[a-f0-9]{32}$/);
    // The filename survives only as sanitised display metadata.
    expect(row.filename).toBe("passwd");
  });
});

describe("upload rejections", () => {
  it("rejects a file larger than the configured maximum", async () => {
    process.env.FILE_MAX_SIZE_MB = "1";

    const res = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "big.txt", content: Buffer.alloc(2 * 1024 * 1024, 0x41) }]))
    );

    expect(res.status).toBe(400);
    expect((await res.json()).results[0]).toMatchObject({ ok: false, reason: "too_large" });
    expect(await prisma.file.count()).toBe(0);
    expect(blobsOnDisk()).toHaveLength(0);
  });

  it("rejects more files than the per-upload limit", async () => {
    process.env.FILE_MAX_PER_UPLOAD = "2";

    const res = await actingAs(USER, () =>
      uploadFiles(
        uploadRequest([
          { name: "a.txt", content: "a" },
          { name: "b.txt", content: "b" },
          { name: "c.txt", content: "c" },
        ])
      )
    );

    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("too_many");
    expect(await prisma.file.count()).toBe(0);
  });

  it("rejects an upload that would exceed the storage quota", async () => {
    process.env.FILE_STORAGE_QUOTA_MB = "1";

    const first = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "a.txt", content: Buffer.alloc(600 * 1024, 0x41) }]))
    );
    expect(first.status).toBe(201);

    const second = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "b.txt", content: Buffer.alloc(600 * 1024, 0x42) }]))
    );

    expect(second.status).toBe(400);
    expect((await second.json()).results[0]).toMatchObject({ reason: "quota_exceeded" });
    expect(await prisma.file.count()).toBe(1);
  });

  it("rejects content that disagrees with its extension", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

    const res = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "invoice.pdf", content: png }]))
    );

    expect(res.status).toBe(400);
    expect((await res.json()).results[0]).toMatchObject({ reason: "mime_mismatch" });
    expect(blobsOnDisk()).toHaveLength(0);
  });

  it("rejects an empty file", async () => {
    const res = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "empty.txt", content: Buffer.alloc(0) }]))
    );

    expect((await res.json()).results[0]).toMatchObject({ reason: "empty" });
  });

  it("reports 207 for a mixed batch rather than hiding either outcome", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const res = await actingAs(USER, () =>
      uploadFiles(
        uploadRequest([
          { name: "good.txt", content: "fine" },
          { name: "bad.pdf", content: png },
        ])
      )
    );

    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(1);
    // The accepted file really was stored; the rejection did not roll it back.
    expect(await prisma.file.count()).toBe(1);
  });

  it("rejects a request with no files at all", async () => {
    const res = await actingAs(USER, () => uploadFiles(uploadRequest([])));
    expect(res.status).toBe(400);
  });
});

describe("archives and unknown binaries", () => {
  it("stores a zip without expanding it", async () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(64, 0x00),
    ]);

    const res = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "bundle.zip", content: zip }]))
    );

    expect(res.status).toBe(201);

    const row = await prisma.file.findFirstOrThrow();
    expect(row.mimeType).toBe("application/zip");
    // Exactly one object on disk: nothing was expanded.
    expect(blobsOnDisk()).toHaveLength(1);
  });

  it("stores unknown binary as octet-stream and marks it unparsed", async () => {
    const bin = Buffer.from([0x00, 0xff, 0x01, 0xfe, 0x00]);

    await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "mystery.dat", content: bin }]))
    );

    const row = await prisma.file.findFirstOrThrow();
    expect(row.mimeType).toBe("application/octet-stream");

    // Queued on upload, then resolved to UNSUPPORTED — "we deliberately did not read
    // this", which is distinct from "we read it and found nothing".
    //
    // The intermediate PENDING/PROCESSING state is deliberately NOT asserted: the
    // upload route fires its own background sweep, so whether the row has been claimed
    // by the time this line runs is a genuine race. The terminal state is the contract.
    const { sweep } = await import("@/lib/extraction/queue");

    let after = row;
    for (let i = 0; i < 40 && ["PENDING", "PROCESSING"].includes(after.extractStatus); i++) {
      await sweep();
      after = await prisma.file.findFirstOrThrow();
      if (["PENDING", "PROCESSING"].includes(after.extractStatus)) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    expect(after.extractStatus).toBe("UNSUPPORTED");
    expect(after.extractReason).toMatch(/cannot be read/i);
  });
});

describe("authentication and activation", () => {
  it("rejects an unauthenticated upload", async () => {
    // signedOut() sets the ambient actor; it is not a wrapper.
    signedOut();

    const res = await uploadFiles(uploadRequest([{ name: "a.txt", content: "a" }]));

    expect(res.status).toBe(401);
    expect(await prisma.file.count()).toBe(0);
  });

  it("rejects a cross-site upload carrying a valid session", async () => {
    const form = new FormData();
    form.append("files", new File([Buffer.from("x")], "a.txt"));

    const res = await actingAs(USER, () =>
      uploadFiles(
        new Request("http://localhost:3000/api/files", {
          method: "POST",
          headers: { "sec-fetch-site": "cross-site" },
          body: form,
        })
      )
    );

    expect(res.status).toBe(403);
    expect(await prisma.file.count()).toBe(0);
  });

  it("rejects a PENDING user", async () => {
    await prisma.user.update({
      where: { clerkUserId: USER.userId },
      data: { status: "PENDING" },
    });

    const res = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "a.txt", content: "a" }]))
    );

    expect(res.status).toBe(403);
  });
});

describe("rate limiting", () => {
  it("uses its own bucket and returns Retry-After", async () => {
    process.env.FILE_UPLOADS_PER_MINUTE = "2";

    for (let i = 0; i < 2; i++) {
      await actingAs(USER, () => uploadFiles(uploadRequest([{ name: `f${i}.txt`, content: "x" }])));
    }

    const res = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "over.txt", content: "x" }]))
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();

    delete process.env.FILE_UPLOADS_PER_MINUTE;
  });
});

describe("listing", () => {
  it("returns only the caller's files, newest first", async () => {
    await actingAs(USER, () => uploadFiles(uploadRequest([{ name: "one.txt", content: "1" }])));
    await actingAs(USER, () => uploadFiles(uploadRequest([{ name: "two.txt", content: "2" }])));

    const res = await actingAs(USER, () => listFiles(listRequest()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.files).toHaveLength(2);
    expect(body.files[0].filename).toBe("two.txt");
  });

  it("reports quota usage", async () => {
    await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "a.txt", content: "1234567890" }]))
    );

    const body = await (await actingAs(USER, () => listFiles(listRequest()))).json();
    expect(body.quota.usedBytes).toBe(10);
    expect(body.quota.limitBytes).toBe(2048 * 1024 * 1024);
  });

  it("never exposes the storage key to the client", async () => {
    await actingAs(USER, () => uploadFiles(uploadRequest([{ name: "a.txt", content: "x" }])));

    const body = await (await actingAs(USER, () => listFiles(listRequest()))).json();
    expect(JSON.stringify(body)).not.toContain("storageKey");
  });
});

describe("aggregate upload payload limit", () => {
  it("allows 10 small files that stay under the aggregate cap", async () => {
    process.env.FILE_MAX_BATCH_MB = "1";

    const res = await actingAs(USER, () =>
      uploadFiles(
        uploadRequest(
          Array.from({ length: 10 }, (_, i) => ({
            name: `small-${i}.txt`,
            content: Buffer.alloc(10 * 1024, 0x41),
          }))
        )
      )
    );

    expect(res.status).toBe(201);
    expect(await prisma.file.count()).toBe(10);
  });

  it("rejects a batch whose TOTAL exceeds the cap even though each file fits", async () => {
    // Per-file and per-count limits alone permit 10 x 25 MB = 250 MB in one request.
    process.env.FILE_MAX_BATCH_MB = "2";
    process.env.FILE_MAX_SIZE_MB = "25";

    const res = await actingAs(USER, () =>
      uploadFiles(
        uploadRequest([
          { name: "a.bin", content: Buffer.alloc(1_200_000, 0x41) },
          { name: "b.bin", content: Buffer.alloc(1_200_000, 0x42) },
        ])
      )
    );

    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("batch_too_large");
  });

  it("writes NO blob and NO row when the aggregate cap is exceeded", async () => {
    process.env.FILE_MAX_BATCH_MB = "1";

    await actingAs(USER, () =>
      uploadFiles(
        uploadRequest([
          { name: "a.bin", content: Buffer.alloc(700 * 1024, 0x41) },
          { name: "b.bin", content: Buffer.alloc(700 * 1024, 0x42) },
        ])
      )
    );

    // The rejection happens before a single byte is buffered or written.
    expect(await prisma.file.count()).toBe(0);
    expect(blobsOnDisk()).toHaveLength(0);
  });

  it("still admits a batch exactly at the cap", async () => {
    process.env.FILE_MAX_BATCH_MB = "1";

    const res = await actingAs(USER, () =>
      uploadFiles(uploadRequest([{ name: "exact.bin", content: Buffer.alloc(1024 * 1024, 0x41) }]))
    );

    expect(res.status).toBe(201);
  });

  it("applies the aggregate cap before the per-file cap is even consulted", async () => {
    // Ordering matters: an oversized aggregate must not be read into memory just to
    // discover each individual file was acceptable.
    process.env.FILE_MAX_BATCH_MB = "1";
    process.env.FILE_MAX_SIZE_MB = "25";

    const res = await actingAs(USER, () =>
      uploadFiles(
        uploadRequest([
          { name: "a.bin", content: Buffer.alloc(800 * 1024, 0x41) },
          { name: "b.bin", content: Buffer.alloc(800 * 1024, 0x42) },
        ])
      )
    );

    expect(res.status).toBe(413);
    // Not a per-file rejection.
    expect((await res.json()).reason).toBe("batch_too_large");
  });
});
