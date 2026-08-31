import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { GET as getConversation } from "@/app/api/conversations/[id]/route";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest, conversationRequest, routeParams } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";
import { BEGIN_MARKER, END_MARKER } from "@/lib/ai/context/prompt";

/**
 * File-aware chat, end to end through the real route against a mocked LiteLLM.
 *
 * The assertions that matter are about what actually reaches the UPSTREAM PAYLOAD.
 * A test that only checks the response body would pass even if unauthorized file content
 * were being sent to the model.
 */

const upstream = setupChatHarness();

const ME = { userId: "ck_fa", email: "fa@test.local" };
const THEM = { userId: "ck_fa2", email: "fa2@test.local" };

let myUserId: string;
let theirUserId: string;

const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

async function makeFile(opts: {
  owner?: string;
  name: string;
  text?: string | null;
  status?: string;
  mimeType?: string;
}) {
  const row = await prisma.file.create({
    data: {
      userId: opts.owner ?? myUserId,
      storageKey: `${opts.owner ?? myUserId}/${opts.name}-${Math.random().toString(16).slice(2)}`,
      filename: opts.name,
      mimeType: opts.mimeType ?? "text/plain",
      sizeBytes: 10,
      checksum: "c".repeat(64),
      extractStatus: (opts.status ?? "EXTRACTED") as never,
      extractedText: opts.text === undefined ? `the text of ${opts.name}` : opts.text,
    },
  });

  return row.id;
}

beforeEach(async () => {
  const me = await seedUser({ clerkUserId: ME.userId, email: ME.email, status: "ACTIVE" });
  const them = await seedUser({ clerkUserId: THEM.userId, email: THEM.email, status: "ACTIVE" });

  myUserId = me.id;
  theirUserId = them.id;
});

describe("a request with no files is unchanged", () => {
  it("sends exactly the same shape as before", async () => {
    const res = await post({ message: "plain question" });

    expect(res.status).toBe(200);

    const sent = upstream.lastRequest()!;
    expect(sent.roles).toEqual(["user"]);
    expect(sent.contents[0]).toBe("plain question");
    // No system message is introduced when nothing is attached.
    expect(sent.roles).not.toContain("system");
  });

  it("carries prior context exactly as it always did", async () => {
    const first = await post({ message: "first" }).then((r) => r.json());
    await post({ message: "second", conversationId: first.conversationId });

    const sent = upstream.lastRequest()!;
    expect(sent.roles).toEqual(["user", "assistant", "user"]);
  });

  it("treats an empty fileIds array as no files", async () => {
    await post({ message: "still plain", fileIds: [] });

    const sent = upstream.lastRequest()!;
    expect(sent.roles).not.toContain("system");
  });
});

describe("a file-aware request", () => {
  it("reaches upstream with the approved file content", async () => {
    const file = await makeFile({ name: "report.txt", text: "QUARTERLY REVENUE 12345" });

    const res = await post({ message: "summarise this", fileIds: [file] });

    expect(res.status).toBe(200);

    const sent = upstream.lastRequest()!;
    expect(sent.roles[0]).toBe("system");
    expect(sent.contents[0]).toContain("QUARTERLY REVENUE 12345");
    expect(sent.contents[0]).toContain(BEGIN_MARKER);
    expect(sent.contents[0]).toContain(END_MARKER);
  });

  it("keeps the user's own message as the final turn", async () => {
    const file = await makeFile({ name: "doc.txt" });

    await post({ message: "what does it say?", fileIds: [file] });

    const sent = upstream.lastRequest()!;
    expect(sent.contents[sent.contents.length - 1]).toBe("what does it say?");
  });

  it("persists the attachment so it survives a reload", async () => {
    const file = await makeFile({ name: "kept.txt" });

    const body = await post({ message: "q", fileIds: [file] }).then((r) => r.json());

    const detail = await actingAs(ME, () =>
      getConversation(conversationRequest(body.conversationId), routeParams(body.conversationId))
    ).then((r) => r.json());

    expect(detail.conversation.attachments).toHaveLength(1);
    expect(detail.conversation.attachments[0].filename).toBe("kept.txt");
  });

  it("does NOT re-read the attachment on a later turn that omits it", async () => {
    // The association persists, but activity does not. A file attached on turn 1 must
    // not keep spending half the context budget on every later turn.
    const file = await makeFile({ name: "sticky.txt", text: "STICKY CONTENT" });

    const first = await post({ message: "first", fileIds: [file] }).then((r) => r.json());
    await post({ message: "follow up", conversationId: first.conversationId });

    const sent = upstream.lastRequest()!;
    expect(sent.contents.join("\n")).not.toContain("STICKY CONTENT");
    expect(sent.roles).not.toContain("system");

    // ...but it is still associated, so the user can select it again.
    expect(await prisma.conversationFile.count()).toBe(1);
  });

  it("never sends extracted text back to the browser", async () => {
    const file = await makeFile({ name: "private.txt", text: "DO NOT ECHO THIS" });

    const res = await post({ message: "q", fileIds: [file] });
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toContain("DO NOT ECHO THIS");
  });
});

describe("unauthorized files never reach upstream", () => {
  it("404s and sends nothing when the file belongs to someone else", async () => {
    const foreign = await makeFile({
      owner: theirUserId,
      name: "theirs.txt",
      text: "SOMEONE ELSES SECRET",
    });

    const res = await post({ message: "summarise this", fileIds: [foreign] });

    expect(res.status).toBe(404);
    // The decisive assertion: no upstream call happened at all.
    expect(upstream.lastRequest()).toBeNull();
  });

  it("404s for a file id that does not exist", async () => {
    const res = await post({ message: "q", fileIds: ["cdoesnotexist000000000000"] });

    expect(res.status).toBe(404);
    expect(upstream.lastRequest()).toBeNull();
  });

  it("rolls the turn back so no orphan message survives", async () => {
    const foreign = await makeFile({ owner: theirUserId, name: "theirs.txt" });

    await post({ message: "summarise this", fileIds: [foreign] });

    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("records no usage for a rejected request", async () => {
    const foreign = await makeFile({ owner: theirUserId, name: "theirs.txt" });

    await post({ message: "q", fileIds: [foreign] });

    expect(await prisma.usage.count()).toBe(0);
  });

  it("rejects the whole batch when one id is foreign", async () => {
    const mine = await makeFile({ name: "mine.txt", text: "MY CONTENT" });
    const foreign = await makeFile({ owner: theirUserId, name: "theirs.txt" });

    const res = await post({ message: "q", fileIds: [mine, foreign] });

    expect(res.status).toBe(404);
    expect(upstream.lastRequest()).toBeNull();
    expect(await prisma.conversationFile.count()).toBe(0);
  });

  it("cannot attach to someone else's conversation through the chat route", async () => {
    const theirConversation = await prisma.conversation.create({
      data: { userId: theirUserId, title: "theirs" },
    });
    const mine = await makeFile({ name: "mine.txt" });

    const res = await post({
      message: "q",
      conversationId: theirConversation.id,
      fileIds: [mine],
    });

    // Rejected by the existing conversation-ownership gate, before any file work.
    expect(res.status).toBe(404);
    expect(upstream.lastRequest()).toBeNull();
  });
});

describe("ineligible files never leak content upstream", () => {
  it.each(["UNSUPPORTED", "FAILED", "PENDING", "PROCESSING", "SKIPPED"])(
    "sends no content for a %s file",
    async (status) => {
      const file = await makeFile({
        name: "x.bin",
        status,
        text: "TEXT THAT MUST NOT BE SENT",
      });

      await post({ message: "q", fileIds: [file] });

      const sent = upstream.lastRequest()!;
      expect(sent.contents.join("\n")).not.toContain("TEXT THAT MUST NOT BE SENT");
    }
  );

  it("tells the model it cannot see an attached image", async () => {
    const file = await makeFile({
      name: "photo.png",
      mimeType: "image/png",
      status: "UNSUPPORTED",
      text: null,
    });

    await post({ message: "what is in this picture?", fileIds: [file] });

    const sent = upstream.lastRequest()!;
    expect(sent.contents[0]).toMatch(/text-only/i);
    expect(sent.contents[0]).toMatch(/cannot see images/i);
  });
});

describe("budget and accounting are unchanged", () => {
  it("never sends more than the configured budget", async () => {
    const a = await makeFile({ name: "a.txt", text: "A".repeat(400_000) });
    const b = await makeFile({ name: "b.txt", text: "B".repeat(400_000) });

    await post({ message: "compare these", fileIds: [a, b] });

    const sent = upstream.lastRequest()!;
    const total = sent.contents.join("").length;

    expect(total).toBeLessThanOrEqual(20_000);
  });

  it("records usage from the upstream response, not an estimate", async () => {
    const file = await makeFile({ name: "u.txt" });

    await post({ message: "q", fileIds: [file] });

    const usage = await prisma.usage.findFirstOrThrow();

    // Whatever the harness reported — never a locally computed number.
    expect(usage.totalTokens).toBeGreaterThan(0);
    expect(usage.requestCount).toBe(1);
  });

  it("creates exactly one usage row per file-aware request", async () => {
    const file = await makeFile({ name: "once.txt" });

    await post({ message: "q1", fileIds: [file] });
    await post({ message: "q2", fileIds: [file] });

    expect(await prisma.usage.count()).toBe(2);
  });

  it("still rolls back and records upstream usage on an empty completion", async () => {
    const file = await makeFile({ name: "e.txt" });
    upstream.setMode("empty");

    const res = await post({ message: "q", fileIds: [file] });

    // Unchanged from the no-file path: the turn is discarded, but the GPU time the
    // model genuinely spent is still charged.
    expect(res.status).toBe(502);
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.usage.count()).toBe(1);
  });

  it("rolls back a file-aware turn when upstream fails", async () => {
    const file = await makeFile({ name: "fail.txt" });
    upstream.setMode("http502");

    const res = await post({ message: "q", fileIds: [file] });

    expect(res.status).toBe(502);
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("leaves no attachment row behind when the turn is rolled back", async () => {
    // The conversation is deleted, so its join rows cascade away with it — no orphan.
    const file = await makeFile({ name: "orphan.txt" });
    upstream.setMode("http502");

    await post({ message: "q", fileIds: [file] });

    expect(await prisma.conversationFile.count()).toBe(0);
    // ...but the file itself survives, because detaching is never deleting.
    expect(await prisma.file.findUnique({ where: { id: file } })).not.toBeNull();
  });
});

describe("active attachments are per turn, not per conversation", () => {
  it("turn 1 with active=[A] sends A only", async () => {
    const a = await makeFile({ name: "a.txt", text: "AAA CONTENT" });
    const b = await makeFile({ name: "b.txt", text: "BBB CONTENT" });

    await post({ message: "about A", fileIds: [a] });

    const sent = upstream.lastRequest()!;
    expect(sent.contents[0]).toContain("AAA CONTENT");
    expect(sent.contents.join("\n")).not.toContain("BBB CONTENT");
    void b;
  });

  it("turn 2 with active=[B] sends B only, not A", async () => {
    const a = await makeFile({ name: "a.txt", text: "AAA CONTENT" });
    const b = await makeFile({ name: "b.txt", text: "BBB CONTENT" });

    const first = await post({ message: "about A", fileIds: [a] }).then((r) => r.json());
    await post({ message: "about B", conversationId: first.conversationId, fileIds: [b] });

    const sent = upstream.lastRequest()!;
    expect(sent.contents[0]).toContain("BBB CONTENT");
    // The decisive assertion: A is associated with this conversation and must NOT leak in.
    expect(sent.contents.join("\n")).not.toContain("AAA CONTENT");
  });

  it("turn 3 with fileIds=[] sends neither", async () => {
    const a = await makeFile({ name: "a.txt", text: "AAA CONTENT" });
    const b = await makeFile({ name: "b.txt", text: "BBB CONTENT" });

    const first = await post({ message: "about A", fileIds: [a] }).then((r) => r.json());
    await post({ message: "about B", conversationId: first.conversationId, fileIds: [b] });
    await post({ message: "no files now", conversationId: first.conversationId, fileIds: [] });

    const sent = upstream.lastRequest()!;
    const all = sent.contents.join("\n");

    expect(all).not.toContain("AAA CONTENT");
    expect(all).not.toContain("BBB CONTENT");
    // Byte-identical to a pre-M3 turn: no system message at all.
    expect(sent.roles).not.toContain("system");
  });

  it("omitting fileIds entirely behaves the same as an empty array", async () => {
    const a = await makeFile({ name: "a.txt", text: "AAA CONTENT" });

    const first = await post({ message: "about A", fileIds: [a] }).then((r) => r.json());
    await post({ message: "plain follow-up", conversationId: first.conversationId });

    const sent = upstream.lastRequest()!;
    expect(sent.contents.join("\n")).not.toContain("AAA CONTENT");
    expect(sent.roles).not.toContain("system");
  });

  it("keeps both files associated with the conversation across turns", async () => {
    const a = await makeFile({ name: "a.txt", text: "AAA CONTENT" });
    const b = await makeFile({ name: "b.txt", text: "BBB CONTENT" });

    const first = await post({ message: "about A", fileIds: [a] }).then((r) => r.json());
    await post({ message: "about B", conversationId: first.conversationId, fileIds: [b] });

    const detail = await actingAs(ME, () =>
      getConversation(conversationRequest(first.conversationId), routeParams(first.conversationId))
    ).then((r) => r.json());

    expect(detail.conversation.attachments).toHaveLength(2);
    expect(
      detail.conversation.attachments.map((f: { filename: string }) => f.filename).sort()
    ).toEqual(["a.txt", "b.txt"]);
  });

  it("reload exposes the association without making anything active", async () => {
    const a = await makeFile({ name: "a.txt", text: "AAA CONTENT" });

    const first = await post({ message: "about A", fileIds: [a] }).then((r) => r.json());

    const detail = await actingAs(ME, () =>
      getConversation(conversationRequest(first.conversationId), routeParams(first.conversationId))
    ).then((r) => r.json());

    // The payload describes what is ASSOCIATED. It carries no notion of "active", so a
    // reloaded client cannot resume sending file content by accident.
    expect(detail.conversation.attachments).toHaveLength(1);
    expect(detail.conversation.attachments[0]).not.toHaveProperty("active");

    // And a turn sent after that reload, with no fileIds, reads nothing.
    await post({ message: "after reload", conversationId: first.conversationId });
    expect(upstream.lastRequest()!.contents.join("\n")).not.toContain("AAA CONTENT");
  });

  it("re-selecting a previously attached file makes it contribute again", async () => {
    const a = await makeFile({ name: "a.txt", text: "AAA CONTENT" });

    const first = await post({ message: "about A", fileIds: [a] }).then((r) => r.json());
    await post({ message: "silent turn", conversationId: first.conversationId });
    await post({ message: "about A again", conversationId: first.conversationId, fileIds: [a] });

    const sent = upstream.lastRequest()!;
    expect(sent.contents[0]).toContain("AAA CONTENT");

    // Re-selecting must not duplicate the association.
    expect(await prisma.conversationFile.count()).toBe(1);
  });

  it("rejects a foreign id named active, with no upstream call", async () => {
    const mine = await makeFile({ name: "mine.txt", text: "MY CONTENT" });
    const foreign = await makeFile({ owner: theirUserId, name: "theirs.txt" });

    const first = await post({ message: "about mine", fileIds: [mine] }).then((r) => r.json());
    upstream.reset();

    const res = await post({
      message: "and theirs",
      conversationId: first.conversationId,
      fileIds: [foreign],
    });

    expect(res.status).toBe(404);
    expect(upstream.lastRequest()).toBeNull();
  });

  it("an inactive associated file consumes zero context budget", async () => {
    const big = await makeFile({ name: "big.txt", text: "Z".repeat(400_000) });
    const small = await makeFile({ name: "small.txt", text: "SMALL CONTENT" });

    const first = await post({ message: "about big", fileIds: [big] }).then((r) => r.json());
    const withBig = upstream.lastRequest()!.totalChars;

    await post({ message: "about small", conversationId: first.conversationId, fileIds: [small] });
    const withSmall = upstream.lastRequest()!.totalChars;

    // If the inactive 400k file still contributed, this turn would be near the budget.
    expect(withBig).toBeGreaterThan(9_000);
    expect(withSmall).toBeLessThan(2_000);
    expect(upstream.lastRequest()!.contents.join("\n")).not.toContain("ZZZ");
  });
});
