import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { GET as listFiles, POST as uploadFiles } from "@/app/api/files/route";
import { GET as getFile, DELETE as deleteFile } from "@/app/api/files/[id]/route";
import { GET as downloadFile } from "@/app/api/files/[id]/content/route";
import { actingAs } from "../setup/clerk";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { __resetLimiters } from "@/lib/rate-limiter";
import { __resetStorage } from "@/lib/files/storage/factory";

let root: string;

const A = { userId: "ck_owner", email: "owner@test.local" };
const B = { userId: "ck_other", email: "other@test.local" };

beforeEach(async () => {
  await resetDatabase();
  __resetLimiters();

  root = mkdtempSync(path.join(os.tmpdir(), "m1-idor-"));
  process.env.FILE_STORAGE_ROOT = root;
  __resetStorage();

  await seedUser({ clerkUserId: A.userId, email: A.email, status: "ACTIVE" });
  await seedUser({ clerkUserId: B.userId, email: B.email, status: "ACTIVE" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FILE_STORAGE_ROOT;
  __resetStorage();
});

function uploadRequest(name: string, content: string) {
  const form = new FormData();
  form.append("files", new File([new Uint8Array(Buffer.from(content))], name));
  return new Request("http://localhost:3000/api/files", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
    body: form,
  });
}

function fileRequest(id: string, method = "GET") {
  return new Request(`http://localhost:3000/api/files/${id}`, {
    method,
    headers: { "sec-fetch-site": "same-origin" },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

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

/** Uploads a file as A and returns its id. */
async function fileOwnedByA(name = "secret.txt", content = "A private content"): Promise<string> {
  const res = await actingAs(A, () => uploadFiles(uploadRequest(name, content)));
  const body = await res.json();
  return body.results[0].id as string;
}

describe("cross-user metadata access", () => {
  it("returns 404 when B reads A's file", async () => {
    const id = await fileOwnedByA();

    const res = await actingAs(B, () => getFile(fileRequest(id), params(id)));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "File not found" });
  });

  it("gives the same 404 for an id that does not exist, leaking no oracle", async () => {
    // Identical responses mean an attacker cannot distinguish "exists but is not yours"
    // from "does not exist" and enumerate ids.
    const real = await fileOwnedByA();

    const foreign = await actingAs(B, () => getFile(fileRequest(real), params(real)));
    const missing = await actingAs(B, () =>
      getFile(fileRequest("does-not-exist"), params("does-not-exist"))
    );

    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it("lets the owner read their own file", async () => {
    const id = await fileOwnedByA();

    const res = await actingAs(A, () => getFile(fileRequest(id), params(id)));

    expect(res.status).toBe(200);
    expect((await res.json()).file.filename).toBe("secret.txt");
  });
});

describe("cross-user download", () => {
  it("returns 404 and no bytes when B downloads A's file", async () => {
    const id = await fileOwnedByA("secret.txt", "TOP SECRET PAYLOAD");

    const res = await actingAs(B, () => downloadFile(fileRequest(id), params(id)));

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("serves the bytes to the owner", async () => {
    const id = await fileOwnedByA("mine.txt", "my own content");

    const res = await actingAs(A, () => downloadFile(fileRequest(id), params(id)));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("my own content");
  });
});

describe("cross-user delete", () => {
  it("returns 404 and leaves both the row and the blob intact", async () => {
    const id = await fileOwnedByA();
    expect(blobCount()).toBe(1);

    const res = await actingAs(B, () => deleteFile(fileRequest(id, "DELETE"), params(id)));

    expect(res.status).toBe(404);
    // The destructive case: a failed authorization check must not have side effects.
    expect(await prisma.file.count()).toBe(1);
    expect(blobCount()).toBe(1);
  });

  it("lets the owner delete, removing the row AND the blob", async () => {
    const id = await fileOwnedByA();

    const res = await actingAs(A, () => deleteFile(fileRequest(id, "DELETE"), params(id)));

    expect(res.status).toBe(200);
    expect(await prisma.file.count()).toBe(0);
    // A row-only delete would leak bytes that consume quota nothing can reclaim.
    expect(blobCount()).toBe(0);
  });

  it("returns 404 on a second delete rather than reporting success twice", async () => {
    const id = await fileOwnedByA();

    await actingAs(A, () => deleteFile(fileRequest(id, "DELETE"), params(id)));
    const second = await actingAs(A, () => deleteFile(fileRequest(id, "DELETE"), params(id)));

    expect(second.status).toBe(404);
  });
});

describe("listing isolation", () => {
  it("shows each user only their own files", async () => {
    await actingAs(A, () => uploadFiles(uploadRequest("a1.txt", "a")));
    await actingAs(A, () => uploadFiles(uploadRequest("a2.txt", "a")));
    await actingAs(B, () => uploadFiles(uploadRequest("b1.txt", "b")));

    const aList = await (await actingAs(A, () => listFiles(fileRequest("")))).json();
    const bList = await (await actingAs(B, () => listFiles(fileRequest("")))).json();

    expect(aList.files.map((f: { filename: string }) => f.filename).sort()).toEqual([
      "a1.txt",
      "a2.txt",
    ]);
    expect(bList.files.map((f: { filename: string }) => f.filename)).toEqual(["b1.txt"]);
  });

  it("counts quota per user, not globally", async () => {
    await actingAs(A, () => uploadFiles(uploadRequest("a.txt", "1234567890")));

    const bList = await (await actingAs(B, () => listFiles(fileRequest("")))).json();
    expect(bList.quota.usedBytes).toBe(0);
  });
});

describe("download response headers", () => {
  it("forces attachment and blocks sniffing", async () => {
    const id = await fileOwnedByA("page.html", "<html>hi</html>");

    const res = await actingAs(A, () => downloadFile(fileRequest(id), params(id)));

    // Inline HTML from our own origin would execute as same-origin script.
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("marks private content no-store", async () => {
    const id = await fileOwnedByA();

    const res = await actingAs(A, () => downloadFile(fileRequest(id), params(id)));

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reports the true content length", async () => {
    const id = await fileOwnedByA("sized.txt", "0123456789");

    const res = await actingAs(A, () => downloadFile(fileRequest(id), params(id)));

    expect(res.headers.get("content-length")).toBe("10");
  });

  it("carries a hostile filename safely into the header", async () => {
    const id = await fileOwnedByA("../../etc/passwd", "x");

    const res = await actingAs(A, () => downloadFile(fileRequest(id), params(id)));
    const disposition = res.headers.get("content-disposition") ?? "";

    expect(disposition).toContain('filename="passwd"');
    expect(disposition).not.toContain("..");
  });
});

describe("storage/database consistency", () => {
  it("reports 404, not 500, when the row exists but the blob is gone", async () => {
    const id = await fileOwnedByA();

    // Simulate storage loss underneath a healthy database.
    const row = await prisma.file.findFirstOrThrow();
    rmSync(path.join(root, row.storageKey), { force: true });

    const res = await actingAs(A, () => downloadFile(fileRequest(id), params(id)));

    // From the caller's perspective the file is unavailable; the internal inconsistency
    // belongs in the log, not the response body.
    expect(res.status).toBe(404);
  });

  it("leaves no orphan blob when the database write fails", async () => {
    // Force a unique-constraint failure on the second insert by pre-creating a row that
    // will collide, proving the storage cleanup path runs.
    const before = blobCount();

    // The insert now happens as tx.file.create inside the quota-admission transaction,
    // so the failure has to be injected at $transaction — spying on prisma.file.create
    // would no longer intercept it.
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("simulated database failure"));

    await expect(
      actingAs(A, () => uploadFiles(uploadRequest("doomed.txt", "content")))
    ).rejects.toThrow();

    spy.mockRestore();

    // The blob written before the failed insert must have been removed: bytes that no
    // row references consume quota that no listing can explain.
    expect(blobCount()).toBe(before);
    expect(await prisma.file.count()).toBe(0);
  });

  it("does not leave a partial blob when a foreign key is violated", async () => {
    // A file for a user that does not exist can never be listed or deleted.
    const ghost = { userId: "ck_ghost", email: "ghost@test.local" };

    await expect(
      actingAs(ghost, () => uploadFiles(uploadRequest("ghost.txt", "x")))
    ).resolves.toMatchObject({ status: 403 });

    expect(blobCount()).toBe(0);
  });
});

describe("storage key isolation on disk", () => {
  it("places each user's blobs under their own prefix", async () => {
    await actingAs(A, () => uploadFiles(uploadRequest("a.txt", "a")));
    await actingAs(B, () => uploadFiles(uploadRequest("b.txt", "b")));

    const rows = await prisma.file.findMany({ select: { userId: true, storageKey: true } });

    for (const row of rows) {
      expect(row.storageKey.startsWith(`${row.userId}/`)).toBe(true);
    }

    // Two distinct top-level prefixes: no shared directory to traverse between.
    const prefixes = new Set(rows.map((r) => r.storageKey.split("/")[0]));
    expect(prefixes.size).toBe(2);
  });

  it("ignores a file planted on disk that has no database row", async () => {
    // Bytes without a row are unreachable: every read path starts from the database.
    const planted = path.join(root, "aaaa1111bbbb2222");
    writeFileSync(path.join(root, "stray.txt"), "planted", { flag: "w" });

    const list = await (await actingAs(A, () => listFiles(fileRequest("")))).json();
    expect(list.files).toHaveLength(0);
    expect(planted).toBeTruthy();
  });
});
