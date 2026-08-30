import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST as uploadFiles } from "@/app/api/files/route";
import { actingAs } from "../setup/clerk";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { __resetLimiters } from "@/lib/rate-limiter";
import { __resetStorage } from "@/lib/files/storage/factory";
import { usedBytes } from "@/lib/files/service";

/**
 * The race this suite closes:
 *
 *   remaining quota = 30 MB
 *   request A uploads 25 MB   ─┐ both measure 30 MB free
 *   request B uploads 25 MB   ─┘ both would commit → 50 MB admitted
 *
 * The fix is a per-user row lock (SELECT ... FOR UPDATE) taken inside the same
 * transaction that measures usage and inserts the row, so the second request blocks
 * until the first commits and then measures the true total.
 *
 * These requests are issued with Promise.all against a real PostgreSQL instance, so the
 * interleaving is genuine rather than simulated.
 */
let root: string;

const A = { userId: "ck_qa", email: "qa@test.local" };
const B = { userId: "ck_qb", email: "qb@test.local" };

const MB = 1024 * 1024;

beforeEach(async () => {
  await resetDatabase();
  __resetLimiters();

  root = mkdtempSync(path.join(os.tmpdir(), "m1-quota-"));
  process.env.FILE_STORAGE_ROOT = root;
  __resetStorage();

  await seedUser({ clerkUserId: A.userId, email: A.email, status: "ACTIVE" });
  await seedUser({ clerkUserId: B.userId, email: B.email, status: "ACTIVE" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FILE_STORAGE_ROOT;
  delete process.env.FILE_STORAGE_QUOTA_MB;
  delete process.env.FILE_MAX_SIZE_MB;
  delete process.env.FILE_MAX_BATCH_MB;
  __resetStorage();
});

function uploadOf(name: string, sizeBytes: number) {
  const form = new FormData();
  form.append("files", new File([new Uint8Array(sizeBytes)], name));
  return new Request("http://localhost:3000/api/files", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
    body: form,
  });
}

function blobCount(): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else n++;
    }
  };
  if (existsSync(root)) walk(root);
  return n;
}

describe("concurrent uploads cannot oversubscribe the quota", () => {
  it("admits only one of two simultaneous uploads that would together exceed it", async () => {
    // 3 MB quota; two concurrent 2 MB uploads. Either alone fits; both do not.
    process.env.FILE_STORAGE_QUOTA_MB = "3";

    const [first, second] = await Promise.all([
      actingAs(A, () => uploadFiles(uploadOf("a.bin", 2 * MB))),
      actingAs(A, () => uploadFiles(uploadOf("b.bin", 2 * MB))),
    ]);

    const statuses = [first.status, second.status].sort();

    // Exactly one accepted (201) and one rejected (400).
    expect(statuses).toEqual([201, 400]);

    expect(await prisma.file.count()).toBe(1);
    expect(await usedBytes((await prisma.user.findFirstOrThrow({ where: { clerkUserId: A.userId } })).id))
      .toBeLessThanOrEqual(3 * MB);
  });

  it("reports quota_exceeded on the rejected request, not a generic error", async () => {
    process.env.FILE_STORAGE_QUOTA_MB = "3";

    const results = await Promise.all([
      actingAs(A, () => uploadFiles(uploadOf("a.bin", 2 * MB))),
      actingAs(A, () => uploadFiles(uploadOf("b.bin", 2 * MB))),
    ]);

    const rejected = results.find((r) => r.status === 400)!;
    const body = await rejected.json();

    expect(body.results[0].reason).toBe("quota_exceeded");
  });

  it("leaves no orphan blob for the rejected upload", async () => {
    process.env.FILE_STORAGE_QUOTA_MB = "3";

    await Promise.all([
      actingAs(A, () => uploadFiles(uploadOf("a.bin", 2 * MB))),
      actingAs(A, () => uploadFiles(uploadOf("b.bin", 2 * MB))),
    ]);

    // The blob is written before the atomic admission, so the rejected request must
    // remove its own bytes. One row, one blob.
    expect(await prisma.file.count()).toBe(1);
    expect(blobCount()).toBe(1);
  });

  it("holds under higher concurrency", async () => {
    // 5 MB quota, five concurrent 2 MB uploads: at most two can fit.
    process.env.FILE_STORAGE_QUOTA_MB = "5";

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        actingAs(A, () => uploadFiles(uploadOf(`f${i}.bin`, 2 * MB)))
      )
    );

    const accepted = responses.filter((r) => r.status === 201).length;

    expect(accepted).toBeLessThanOrEqual(2);
    expect(await prisma.file.count()).toBe(accepted);

    const user = await prisma.user.findFirstOrThrow({ where: { clerkUserId: A.userId } });
    expect(await usedBytes(user.id)).toBeLessThanOrEqual(5 * MB);
  });

  it("never admits more bytes than the quota, whatever the interleaving", async () => {
    process.env.FILE_STORAGE_QUOTA_MB = "4";

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        actingAs(A, () => uploadFiles(uploadOf(`g${i}.bin`, 1 * MB)))
      )
    );

    const user = await prisma.user.findFirstOrThrow({ where: { clerkUserId: A.userId } });
    const used = await usedBytes(user.id);

    // The invariant that matters: the stored total is never above the configured cap.
    expect(used).toBeLessThanOrEqual(4 * MB);
  });
});

describe("users do not block each other", () => {
  it("admits concurrent uploads from different users independently", async () => {
    // The lock is on the USER row, so A and B contend with nobody. Each has its own
    // 3 MB quota and both 2 MB uploads must succeed.
    process.env.FILE_STORAGE_QUOTA_MB = "3";

    const [fromA, fromB] = await Promise.all([
      actingAs(A, () => uploadFiles(uploadOf("a.bin", 2 * MB))),
      actingAs(B, () => uploadFiles(uploadOf("b.bin", 2 * MB))),
    ]);

    expect(fromA.status).toBe(201);
    expect(fromB.status).toBe(201);
    expect(await prisma.file.count()).toBe(2);
  });
});

describe("quota is returned when a file is deleted", () => {
  it("frees the space for a subsequent upload", async () => {
    process.env.FILE_STORAGE_QUOTA_MB = "3";

    const first = await actingAs(A, () => uploadFiles(uploadOf("a.bin", 2 * MB)));
    expect(first.status).toBe(201);

    // Full: a second 2 MB file does not fit.
    const blocked = await actingAs(A, () => uploadFiles(uploadOf("b.bin", 2 * MB)));
    expect(blocked.status).toBe(400);

    const row = await prisma.file.findFirstOrThrow();
    await prisma.file.delete({ where: { id: row.id } });

    // Quota is derived from File rows, so removing the row returns the space with no
    // separate accounting to keep in step.
    const afterDelete = await actingAs(A, () => uploadFiles(uploadOf("c.bin", 2 * MB)));
    expect(afterDelete.status).toBe(201);
  });
});

describe("no phantom reservations survive a crash", () => {
  it("computes usage purely from committed File rows", async () => {
    // There is no reservation table to leak. A process that dies mid-upload leaves at
    // most an orphan blob, which is invisible and consumes no quota.
    process.env.FILE_STORAGE_QUOTA_MB = "3";

    const user = await prisma.user.findFirstOrThrow({ where: { clerkUserId: A.userId } });
    expect(await usedBytes(user.id)).toBe(0);

    await actingAs(A, () => uploadFiles(uploadOf("a.bin", 1 * MB)));

    // Exactly the committed row's size — nothing reserved, nothing pending.
    const committed = await prisma.file.aggregate({ _sum: { sizeBytes: true }, where: { userId: user.id } });
    expect(await usedBytes(user.id)).toBe(committed._sum.sizeBytes);
  });
});
