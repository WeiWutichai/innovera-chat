import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST as attach, GET as listAttached } from "@/app/api/conversations/[id]/files/route";
import { DELETE as detach } from "@/app/api/conversations/[id]/files/[fileId]/route";
import { actingAs } from "../setup/clerk";
import { resetDatabase, prisma } from "../setup/database";
import { seedUser } from "../setup/seed";

/**
 * The IDOR matrix for attachments.
 *
 * Every operation must prove BOTH endpoints belong to the caller. The four combinations
 * below are the whole attack surface, and three of them must be indistinguishable from
 * "no such conversation" — a distinct 403 for "exists but not yours" would confirm the
 * row exists and let an attacker enumerate other users' ids.
 */

const ME = { userId: "ck_owner", email: "owner@test.local" };
const THEM = { userId: "ck_other", email: "other@test.local" };

let myUserId: string;
let theirUserId: string;
let myConversation: string;
let theirConversation: string;
let myFile: string;
let theirFile: string;

function attachRequest(body: unknown) {
  return new Request("http://localhost:3000/api/conversations/x/files", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

function plainRequest(method = "GET") {
  return new Request("http://localhost:3000/api/conversations/x/files", {
    method,
    headers: { "sec-fetch-site": "same-origin" },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const detachParams = (id: string, fileId: string) => ({
  params: Promise.resolve({ id, fileId }),
});

async function seedFile(userId: string, name: string) {
  const row = await prisma.file.create({
    data: {
      userId,
      storageKey: `${userId}/${name}${"0".repeat(20)}`.slice(0, 60),
      filename: name,
      mimeType: "text/plain",
      sizeBytes: 10,
      checksum: "c".repeat(64),
      extractStatus: "EXTRACTED",
      extractedText: "content of " + name,
      extractedChars: 10,
    },
  });

  return row.id;
}

beforeEach(async () => {
  await resetDatabase();

  const me = await seedUser({ clerkUserId: ME.userId, email: ME.email });
  const them = await seedUser({ clerkUserId: THEM.userId, email: THEM.email });

  myUserId = me.id;
  theirUserId = them.id;

  myConversation = (
    await prisma.conversation.create({ data: { userId: myUserId, title: "mine" } })
  ).id;

  theirConversation = (
    await prisma.conversation.create({ data: { userId: theirUserId, title: "theirs" } })
  ).id;

  myFile = await seedFile(myUserId, "mine.txt");
  theirFile = await seedFile(theirUserId, "theirs.txt");
});

describe("the four ownership combinations", () => {
  it("own conversation + own file -> allowed", async () => {
    const res = await actingAs(ME, () =>
      attach(attachRequest({ fileIds: [myFile] }), params(myConversation))
    );

    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].id).toBe(myFile);
  });

  it("own conversation + foreign file -> 404", async () => {
    const res = await actingAs(ME, () =>
      attach(attachRequest({ fileIds: [theirFile] }), params(myConversation))
    );

    expect(res.status).toBe(404);
    expect(await prisma.conversationFile.count()).toBe(0);
  });

  it("foreign conversation + own file -> 404", async () => {
    const res = await actingAs(ME, () =>
      attach(attachRequest({ fileIds: [myFile] }), params(theirConversation))
    );

    expect(res.status).toBe(404);
    expect(await prisma.conversationFile.count()).toBe(0);
  });

  it("foreign conversation + foreign file -> 404", async () => {
    const res = await actingAs(ME, () =>
      attach(attachRequest({ fileIds: [theirFile] }), params(theirConversation))
    );

    expect(res.status).toBe(404);
    expect(await prisma.conversationFile.count()).toBe(0);
  });
});

describe("no information oracle", () => {
  it("returns the same status and body for every failure shape", async () => {
    const cases = [
      [myConversation, theirFile],
      [theirConversation, myFile],
      [theirConversation, theirFile],
      [myConversation, "cnonexistentfileid00000000"],
      ["cnonexistentconvid0000000", myFile],
    ] as const;

    const responses = await Promise.all(
      cases.map(([conversationId, fileId]) =>
        actingAs(ME, () => attach(attachRequest({ fileIds: [fileId] }), params(conversationId)))
      )
    );

    const bodies = await Promise.all(responses.map((r) => r.json()));

    // A missing id and someone else's id are indistinguishable.
    for (const res of responses) expect(res.status).toBe(404);
    for (const body of bodies) expect(body).toEqual({ error: "Conversation not found" });
  });

  it("is all-or-nothing: one foreign id in a batch attaches nothing", async () => {
    // Partial success would leak exactly which ids were valid.
    const res = await actingAs(ME, () =>
      attach(attachRequest({ fileIds: [myFile, theirFile] }), params(myConversation))
    );

    expect(res.status).toBe(404);
    expect(await prisma.conversationFile.count()).toBe(0);
  });
});

describe("never trusts a userId from the request body", () => {
  it("ignores a userId claiming to be the other user", async () => {
    const res = await actingAs(ME, () =>
      attach(
        attachRequest({ fileIds: [theirFile], userId: theirUserId }),
        params(myConversation)
      )
    );

    expect(res.status).toBe(404);
  });

  it("ignores a userId claiming ownership of a foreign conversation", async () => {
    const res = await actingAs(ME, () =>
      attach(
        attachRequest({ fileIds: [myFile], userId: theirUserId }),
        params(theirConversation)
      )
    );

    expect(res.status).toBe(404);
  });
});

describe("detach isolation", () => {
  beforeEach(async () => {
    await prisma.conversationFile.create({
      data: { conversationId: myConversation, fileId: myFile },
    });
    await prisma.conversationFile.create({
      data: { conversationId: theirConversation, fileId: theirFile },
    });
  });

  it("detaches my own attachment", async () => {
    const res = await actingAs(ME, () =>
      detach(plainRequest("DELETE"), detachParams(myConversation, myFile))
    );

    expect(res.status).toBe(200);
    expect(
      await prisma.conversationFile.count({ where: { conversationId: myConversation } })
    ).toBe(0);
  });

  it("cannot detach from someone else's conversation", async () => {
    const res = await actingAs(ME, () =>
      detach(plainRequest("DELETE"), detachParams(theirConversation, theirFile))
    );

    expect(res.status).toBe(404);
    // Still attached: the other user's conversation is untouched.
    expect(
      await prisma.conversationFile.count({ where: { conversationId: theirConversation } })
    ).toBe(1);
  });

  it("cannot detach a foreign file even from my own conversation", async () => {
    const res = await actingAs(ME, () =>
      detach(plainRequest("DELETE"), detachParams(myConversation, theirFile))
    );

    expect(res.status).toBe(404);
  });

  it("detaching does NOT delete the file", async () => {
    await actingAs(ME, () =>
      detach(plainRequest("DELETE"), detachParams(myConversation, myFile))
    );

    const file = await prisma.file.findUnique({ where: { id: myFile } });

    expect(file).not.toBeNull();
    expect(file?.extractedText).toBe("content of mine.txt");
  });
});

describe("listing attachments", () => {
  it("lists only my own conversation's attachments", async () => {
    await prisma.conversationFile.create({
      data: { conversationId: myConversation, fileId: myFile },
    });

    const res = await actingAs(ME, () => listAttached(plainRequest(), params(myConversation)));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.attachments).toHaveLength(1);
  });

  it("404s for a conversation belonging to someone else", async () => {
    const res = await actingAs(ME, () =>
      listAttached(plainRequest(), params(theirConversation))
    );

    expect(res.status).toBe(404);
  });

  it("never returns extracted text to the browser", async () => {
    await prisma.conversationFile.create({
      data: { conversationId: myConversation, fileId: myFile },
    });

    const body = await actingAs(ME, () =>
      listAttached(plainRequest(), params(myConversation))
    ).then((r) => r.json());

    expect(JSON.stringify(body)).not.toContain("content of mine.txt");
    expect(body.attachments[0]).not.toHaveProperty("extractedText");
  });
});

describe("the standard gates still apply", () => {
  it("rejects a cross-site request", async () => {
    const req = new Request("http://localhost:3000/api/conversations/x/files", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ fileIds: [myFile] }),
    });

    const res = await actingAs(ME, () => attach(req, params(myConversation)));

    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await attach(attachRequest({ fileIds: [myFile] }), params(myConversation));

    expect(res.status).toBe(401);
  });

  it("rejects a non-ACTIVE user", async () => {
    await prisma.user.update({ where: { id: myUserId }, data: { status: "DISABLED" } });

    const res = await actingAs(ME, () =>
      attach(attachRequest({ fileIds: [myFile] }), params(myConversation))
    );

    expect(res.status).toBe(403);
  });
});
