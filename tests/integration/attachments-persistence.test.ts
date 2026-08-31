import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { GET as getConversation } from "@/app/api/conversations/[id]/route";
import { DELETE as deleteFile } from "@/app/api/files/[id]/route";
import { actingAs } from "../setup/clerk";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { conversationRequest, routeParams } from "../setup/requests";
import { __resetStorage } from "@/lib/files/storage/factory";
import { detachFile, listAttachments } from "@/lib/ai/context/attachments";

/**
 * The attachment lifecycle.
 *
 * The rule these tests pin down: a File outlives its attachments. Detaching removes a
 * link; deleting a conversation removes links; only deleting the File itself removes the
 * File. Anything else would mean removing a file from one conversation silently destroyed
 * it in another.
 */

const ME = { userId: "ck_persist", email: "persist@test.local" };

let root: string;
let userId: string;
let conversationA: string;
let conversationB: string;

async function makeFile(name: string) {
  const id = `${name.replace(/\W/g, "")}${"0".repeat(25)}`.slice(0, 25);
  const storageKey = `${userId}/${id}`;

  mkdirSync(path.join(root, userId), { recursive: true });
  writeFileSync(path.join(root, storageKey), Buffer.from(`bytes of ${name}`));

  const row = await prisma.file.create({
    data: {
      id,
      userId,
      storageKey,
      filename: name,
      mimeType: "text/plain",
      sizeBytes: 10,
      checksum: "c".repeat(64),
      extractStatus: "EXTRACTED",
      extractedText: `text of ${name}`,
    },
  });

  return row.id;
}

beforeEach(async () => {
  await resetDatabase();

  root = mkdtempSync(path.join(os.tmpdir(), "m3-persist-"));
  process.env.FILE_STORAGE_ROOT = root;
  __resetStorage();

  const me = await seedUser({ clerkUserId: ME.userId, email: ME.email });
  userId = me.id;

  conversationA = (await prisma.conversation.create({ data: { userId, title: "A" } })).id;
  conversationB = (await prisma.conversation.create({ data: { userId, title: "B" } })).id;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FILE_STORAGE_ROOT;
  __resetStorage();
});

describe("attachments survive a reload", () => {
  it("comes back with the conversation", async () => {
    const file = await makeFile("kept.txt");
    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });

    const detail = await actingAs(ME, () =>
      getConversation(conversationRequest(conversationA), routeParams(conversationA))
    ).then((r) => r.json());

    expect(detail.conversation.attachments).toHaveLength(1);
    expect(detail.conversation.attachments[0]).toMatchObject({
      filename: "kept.txt",
      extractStatus: "EXTRACTED",
    });
  });

  it("carries the status so the UI can be honest after a reload", async () => {
    const file = await makeFile("scan.pdf");
    await prisma.file.update({
      where: { id: file },
      data: { extractStatus: "FAILED", extractReason: "no text layer" },
    });
    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });

    const detail = await actingAs(ME, () =>
      getConversation(conversationRequest(conversationA), routeParams(conversationA))
    ).then((r) => r.json());

    expect(detail.conversation.attachments[0].extractStatus).toBe("FAILED");
  });

  it("never includes extracted text in the reload payload", async () => {
    const file = await makeFile("secret.txt");
    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });

    const raw = await actingAs(ME, () =>
      getConversation(conversationRequest(conversationA), routeParams(conversationA))
    ).then((r) => r.text());

    expect(raw).not.toContain("text of secret.txt");
  });

  it("returns attachments in a deterministic order", async () => {
    const a = await makeFile("one.txt");
    const b = await makeFile("two.txt");

    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: a } });
    await new Promise((r) => setTimeout(r, 5));
    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: b } });

    const detail = await actingAs(ME, () =>
      getConversation(conversationRequest(conversationA), routeParams(conversationA))
    ).then((r) => r.json());

    expect(detail.conversation.attachments.map((f: { filename: string }) => f.filename)).toEqual([
      "one.txt",
      "two.txt",
    ]);
  });
});

describe("one file, several conversations", () => {
  it("can be attached to two conversations without duplicating the blob", async () => {
    const file = await makeFile("shared.txt");

    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });
    await prisma.conversationFile.create({ data: { conversationId: conversationB, fileId: file } });

    // One File row, one blob, two links.
    expect(await prisma.file.count()).toBe(1);
    expect(await prisma.conversationFile.count()).toBe(2);
  });

  it("detaching from one leaves the other intact", async () => {
    const file = await makeFile("shared.txt");

    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });
    await prisma.conversationFile.create({ data: { conversationId: conversationB, fileId: file } });

    await detachFile(userId, conversationA, file);

    expect(await listAttachments(userId, conversationA)).toHaveLength(0);
    expect(await listAttachments(userId, conversationB)).toHaveLength(1);
  });

  it("is idempotent: attaching twice does not duplicate", async () => {
    const file = await makeFile("once.txt");

    await prisma.conversationFile.createMany({
      data: [
        { conversationId: conversationA, fileId: file },
        { conversationId: conversationA, fileId: file },
      ],
      skipDuplicates: true,
    });

    expect(await prisma.conversationFile.count()).toBe(1);
  });
});

describe("detaching never deletes", () => {
  it("preserves the File row, its text and its blob", async () => {
    const file = await makeFile("keepme.txt");
    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });

    await detachFile(userId, conversationA, file);

    const row = await prisma.file.findUnique({ where: { id: file } });

    expect(row).not.toBeNull();
    expect(row?.extractedText).toBe("text of keepme.txt");
    expect(existsSync(path.join(root, row!.storageKey))).toBe(true);
  });

  it("is a no-op when the file is already detached", async () => {
    const file = await makeFile("gone.txt");

    await expect(detachFile(userId, conversationA, file)).resolves.toBe(true);
  });
});

describe("deleting a conversation", () => {
  it("removes its join rows but keeps the files", async () => {
    const file = await makeFile("survivor.txt");
    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });

    await prisma.conversation.delete({ where: { id: conversationA } });

    expect(await prisma.conversationFile.count()).toBe(0);
    expect(await prisma.file.count()).toBe(1);
  });
});

describe("deleting a file", () => {
  it("removes its join rows without touching the conversation or its messages", async () => {
    const file = await makeFile("doomed.txt");

    await prisma.message.create({
      data: { conversationId: conversationA, role: "USER", content: "a question" },
    });
    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });

    const res = await actingAs(ME, () =>
      deleteFile(
        new Request(`http://localhost:3000/api/files/${file}`, {
          method: "DELETE",
          headers: { "sec-fetch-site": "same-origin" },
        }),
        routeParams(file)
      )
    );

    expect(res.status).toBe(200);

    // The join row cascaded away; the conversation and its history did not.
    expect(await prisma.conversationFile.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(2);
    expect(await prisma.message.count()).toBe(1);
  });

  it("leaves no dangling join row for a file attached to several conversations", async () => {
    const file = await makeFile("wide.txt");

    await prisma.conversationFile.create({ data: { conversationId: conversationA, fileId: file } });
    await prisma.conversationFile.create({ data: { conversationId: conversationB, fileId: file } });

    await actingAs(ME, () =>
      deleteFile(
        new Request(`http://localhost:3000/api/files/${file}`, {
          method: "DELETE",
          headers: { "sec-fetch-site": "same-origin" },
        }),
        routeParams(file)
      )
    );

    expect(await prisma.conversationFile.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(2);
  });

  it("removes the blob as well as the row", async () => {
    const file = await makeFile("blobby.txt");
    const row = await prisma.file.findUniqueOrThrow({ where: { id: file } });

    await actingAs(ME, () =>
      deleteFile(
        new Request(`http://localhost:3000/api/files/${file}`, {
          method: "DELETE",
          headers: { "sec-fetch-site": "same-origin" },
        }),
        routeParams(file)
      )
    );

    expect(existsSync(path.join(root, row.storageKey))).toBe(false);
  });
});
