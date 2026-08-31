import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => import("../setup/clerk"));

import { POST } from "@/app/api/chat/route";
import { actingAs } from "../setup/clerk";
import { prisma } from "../setup/database";
import { seedUser } from "../setup/seed";
import { chatRequest } from "../setup/requests";
import { setupChatHarness } from "../setup/harness";
import { estimatePayloadTokens } from "@/lib/ai/context/tokens";

/**
 * The token-safety guard, through the real route.
 *
 * The guard's whole value is that it runs BEFORE the upstream call, so the assertion
 * that matters in every rejection test is `upstream.lastRequest()` being null. A test
 * that only checked the status code would pass even if the GPU had already been spent.
 */

const upstream = setupChatHarness();

const ME = { userId: "ck_tok", email: "tok@test.local" };
let myUserId: string;

const post = (body: unknown) => actingAs(ME, () => POST(chatRequest(body)));

/** Built from code points so no emoji literal appears in this source file. */
const GRINNING = String.fromCodePoint(0x1f600);
const PARTY = String.fromCodePoint(0x1f389);

function estimateOf(sent: { roles: string[]; contents: string[] }): number {
  return estimatePayloadTokens(
    sent.roles.map((role, i) => ({ role, content: sent.contents[i] }))
  );
}

async function makeFile(name: string, text: string) {
  const row = await prisma.file.create({
    data: {
      userId: myUserId,
      storageKey: `${myUserId}/${name}-${Math.random().toString(16).slice(2)}`,
      filename: name,
      mimeType: "text/plain",
      sizeBytes: 10,
      checksum: "c".repeat(64),
      extractStatus: "EXTRACTED",
      extractedText: text,
    },
  });

  return row.id;
}

beforeEach(async () => {
  const me = await seedUser({ clerkUserId: ME.userId, email: ME.email, status: "ACTIVE" });
  myUserId = me.id;
});

afterEach(() => {
  delete process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS;
});

describe("safe payloads are unaffected", () => {
  it("sends an ordinary English request unchanged", async () => {
    const res = await post({ message: "what is the capital of France?" });

    expect(res.status).toBe(200);
    expect(upstream.lastRequest()!.contents[0]).toBe("what is the capital of France?");
  });

  it("sends an ordinary Thai request unchanged", async () => {
    const thai = "ช่วยสรุปเอกสารนี้ให้หน่อยครับ";
    const res = await post({ message: thai });

    expect(res.status).toBe(200);
    expect(upstream.lastRequest()!.contents[0]).toBe(thai);
  });

  it("sends a full Thai character budget without tripping the guard", async () => {
    // The worst realistic case the character budget permits must still go through, or
    // Thai users are rejected in normal use.
    const res = await post({ message: "ก".repeat(19_000) });

    expect(res.status).toBe(200);
    expect(upstream.lastRequest()).not.toBeNull();
  });

  it("sends CJK, Thai and emoji together when within budget", async () => {
    const res = await post({ message: `这是一个测试 ${PARTY} mixed สวัสดี` });

    expect(res.status).toBe(200);
    expect(upstream.lastRequest()).not.toBeNull();
  });
});

describe("an unsafe payload never reaches LiteLLM", () => {
  it("refuses an emoji-dense message that estimates over the limit", async () => {
    // 9,000 emoji: inside the character budget, far outside any sane token budget.
    const res = await post({ message: GRINNING.repeat(9_000) });

    expect(res.status).toBe(400);
    expect(upstream.lastRequest()).toBeNull();
  });

  it("spends no quota and records no usage when it refuses", async () => {
    await post({ message: GRINNING.repeat(9_000) });

    expect(await prisma.usage.count()).toBe(0);
  });

  it("rolls the turn back so no orphan message survives", async () => {
    await post({ message: GRINNING.repeat(9_000) });

    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("returns a classified reason rather than a generic failure", async () => {
    const body = await post({ message: GRINNING.repeat(9_000) }).then((r) => r.json());

    expect(body.reason).toBe("context_too_large");
    expect(body.error).toBeTruthy();
    // Never an internal message or an estimate the user cannot act on.
    expect(body.error).not.toMatch(/token|estimate|Error/i);
  });

  it("refuses rather than silently truncating the user's own message", async () => {
    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "200";

    const res = await post({ message: "ก".repeat(5_000) });

    // The alternative — sending a truncated question — would produce a confident answer
    // to something the user never asked.
    expect(res.status).toBe(400);
    expect(upstream.lastRequest()).toBeNull();
  });
});

describe("the guard shrinks before it refuses", () => {
  it("drops file context to fit rather than failing outright", async () => {
    const file = await makeFile("big.txt", "ก".repeat(200_000));

    // Tight enough that the full file allocation cannot fit, loose enough that the
    // message and some history can.
    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "2000";

    const res = await post({ message: "สรุปให้หน่อย", fileIds: [file] });

    expect(res.status).toBe(200);
    expect(estimateOf(upstream.lastRequest()!)).toBeLessThanOrEqual(2_000);
  });

  it("keeps the user's message intact while shrinking everything else", async () => {
    const file = await makeFile("big.txt", "ก".repeat(200_000));
    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "2000";

    const message = "สรุปเอกสารนี้ให้หน่อยครับ";
    await post({ message, fileIds: [file] });

    const sent = upstream.lastRequest()!;
    expect(sent.contents[sent.contents.length - 1]).toBe(message);
  });

  it("shrinks history when a large file and a long history compete", async () => {
    const file = await makeFile("doc.txt", "ก".repeat(100_000));
    const first = await post({ message: "เริ่มต้น" }).then((r) => r.json());

    for (let i = 0; i < 6; i++) {
      await post({ message: "ข".repeat(1_500), conversationId: first.conversationId });
    }

    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "4000";

    const res = await post({
      message: "สรุปทั้งหมด",
      conversationId: first.conversationId,
      fileIds: [file],
    });

    expect(res.status).toBe(200);
    expect(estimateOf(upstream.lastRequest()!)).toBeLessThanOrEqual(4_000);
  });

  it("never exceeds the character budget at any shrink step", async () => {
    const a = await makeFile("a.txt", "ก".repeat(200_000));
    const b = await makeFile("b.txt", "ข".repeat(200_000));

    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "3000";

    await post({ message: "เปรียบเทียบสองไฟล์นี้", fileIds: [a, b] });

    expect(upstream.lastRequest()!.totalChars).toBeLessThanOrEqual(20_000);
  });

  it("is deterministic: the same inputs shrink to the same payload", async () => {
    const file = await makeFile("d.txt", "ก".repeat(120_000));
    process.env.CHAT_MAX_ESTIMATED_INPUT_TOKENS = "2500";

    await post({ message: "คำถาม", fileIds: [file] });
    const first = upstream.lastRequest()!.contents.join(" ");

    await post({ message: "คำถาม", fileIds: [file] });
    const second = upstream.lastRequest()!.contents.join(" ");

    expect(second).toBe(first);
  });
});

describe("the estimate is a guard, not an accounting figure", () => {
  it("records only the tokens LiteLLM reported, never the estimate", async () => {
    const res = await post({ message: "a normal question" });
    expect(res.status).toBe(200);

    const usage = await prisma.usage.findFirstOrThrow();
    const body = await res.json();

    // Quota accounting still comes from upstream, exactly as before M3.
    expect(usage.promptTokens).toBe(body.usage.prompt_tokens);
    expect(usage.totalTokens).toBe(body.usage.total_tokens);
  });
});
