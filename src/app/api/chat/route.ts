import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { chatConfig, getUpstreamConfig } from "@/lib/chat-config";
import {
  checkRateLimit,
  acquireSlot,
  createSlotRelease,
} from "@/lib/rate-limiter";
import { checkDailyQuota } from "@/lib/usage-quota";
import { selectContextWithinBudget } from "@/lib/context-window";
import { logInfo, logWarn, logError } from "@/lib/log";

const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(chatConfig.maxMessageLength),
  conversationId: z.string().nullish(),
});

type ChatCompletion = {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

// Fixed strings. Upstream error text is never forwarded to the browser: it can carry
// provider, host, model and internal configuration detail no end user should see. The
// underlying model identity (Qwen) is never exposed — the browser only ever sees the
// "innovera-ai" alias it already knows.
const UPSTREAM_BUSY =
  "ระบบ AI มีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกครั้ง";
const UPSTREAM_UNAVAILABLE =
  "ระบบ AI ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง";
const UPSTREAM_EMPTY =
  "ระบบ AI ไม่ได้ส่งคำตอบกลับมา กรุณาลองใหม่อีกครั้ง";
const UPSTREAM_TIMEOUT =
  "ระบบ AI ใช้เวลาตอบนานเกินกำหนด กรุณาลองใหม่อีกครั้ง";
const NOT_CONFIGURED =
  "ระบบ AI ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ";
const RATE_LIMITED =
  "คุณส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่";
const TOO_MANY_IN_FLIGHT =
  "คุณมีคำขอที่กำลังประมวลผลอยู่ กรุณารอให้เสร็จก่อน";
const QUOTA_EXCEEDED =
  "คุณใช้โควตาโทเค็นประจำวันครบแล้ว กรุณาลองใหม่ในวันถัดไป";
const REQUEST_CANCELLED = "ยกเลิกคำขอแล้ว";

function messageForUpstreamStatus(status: number) {
  return status === 429 ? UPSTREAM_BUSY : UPSTREAM_UNAVAILABLE;
}

// The Clerk session cookie rides along on any cross-site POST, so without this a page
// on another origin could spend a signed-in user's quota. Sec-Fetch-Site is the primary
// check because it needs no server configuration; the Origin/Host comparison is only a
// fallback for clients that do not send it.
function isCrossSiteRequest(req: Request) {
  const site = req.headers.get("sec-fetch-site");

  if (site) {
    return site !== "same-origin" && site !== "none";
  }

  const origin = req.headers.get("origin");

  if (!origin) {
    return false;
  }

  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");

  if (!host) {
    return false;
  }

  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function POST(req: Request) {
  const correlationId = crypto.randomUUID().slice(0, 8);

  // Set once the user's turn is persisted, so any later failure can undo it.
  let rollbackTurn: (() => Promise<void>) | null = null;
  // Set once a concurrency slot is held. Released exactly once in `finally`.
  let releaseConcurrencySlot: (() => void) | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    if (isCrossSiteRequest(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const { userId } = await auth();

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validated before any database work so a misconfigured deployment fails cleanly
    // instead of persisting a turn it can never answer.
    const upstream = getUpstreamConfig();

    if (!upstream) {
      return Response.json(
        { error: NOT_CONFIGURED, reason: "not_configured", correlationId },
        { status: 503 }
      );
    }

    const appUser = await prisma.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!appUser || appUser.status !== "ACTIVE") {
      return Response.json(
        { error: "Account is not active" },
        { status: 403 }
      );
    }

    // Cheapest rejection first: no body parsing, no slot, no database read. Aborted and
    // rejected attempts are recorded too, so hammering cannot reset the window.
    const rate = checkRateLimit(appUser.id, chatConfig.rateLimitPerMinute);

    if (!rate.allowed) {
      logWarn("chat.rate_limited", {
        correlationId,
        userId: appUser.id,
        retryAfterSeconds: rate.retryAfterSeconds,
      });

      return Response.json(
        { error: RATE_LIMITED, reason: "rate_limited", correlationId },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
      );
    }

    let rawBody: unknown;

    try {
      rawBody = await req.json();
    } catch {
      return Response.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const parsed = chatRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
      const tooLong = parsed.error.issues.some(
        (issue) => issue.code === "too_big"
      );

      return Response.json(
        { error: tooLong ? "Message is too long" : "Message is required" },
        { status: 400 }
      );
    }

    const message = parsed.data.message;
    const requestedConversationId = parsed.data.conversationId ?? null;

    // Acquired BEFORE the quota read. This is what bounds quota overshoot: at most
    // `maxConcurrentPerUser` requests can be racing the check at any instant.
    if (!acquireSlot(appUser.id, chatConfig.maxConcurrentPerUser)) {
      logWarn("chat.concurrency_rejected", {
        correlationId,
        userId: appUser.id,
        limit: chatConfig.maxConcurrentPerUser,
      });

      return Response.json(
        { error: TOO_MANY_IN_FLIGHT, reason: "concurrency_limit", correlationId },
        { status: 429 }
      );
    }

    releaseConcurrencySlot = createSlotRelease(appUser.id);

    const quota = await checkDailyQuota(appUser.id, appUser.dailyTokenLimit);

    if (!quota.withinQuota) {
      logWarn("chat.quota_exceeded", {
        correlationId,
        userId: appUser.id,
        usedToday: quota.used,
        dailyTokenLimit: quota.limit,
      });

      return Response.json(
        {
          error: QUOTA_EXCEEDED,
          reason: "quota_exceeded",
          correlationId,
          usedToday: quota.used,
          dailyTokenLimit: quota.limit,
        },
        { status: 429 }
      );
    }

    let conversationId: string;
    let conversationTitle: string | null;
    let userMessageId: string;
    let createdConversation = false;

    if (requestedConversationId) {
      const existing = await prisma.conversation.findFirst({
        where: {
          id: requestedConversationId,
          userId: appUser.id,
        },
        select: { id: true, title: true },
      });

      if (!existing) {
        return Response.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }

      const userMessage = await prisma.message.create({
        data: {
          conversationId: existing.id,
          role: "USER",
          content: message,
        },
        select: { id: true },
      });

      conversationId = existing.id;
      conversationTitle = existing.title;
      userMessageId = userMessage.id;
    } else {
      const title =
        message.length > 60
          ? message.slice(0, 60) + "..."
          : message;

      // Nested create: a conversation never exists without its first message, so a
      // failure between the two can no longer leave an empty conversation behind.
      const created = await prisma.conversation.create({
        data: {
          userId: appUser.id,
          title,
          messages: {
            create: { role: "USER", content: message },
          },
        },
        select: {
          id: true,
          title: true,
          messages: { select: { id: true } },
        },
      });

      conversationId = created.id;
      conversationTitle = created.title;
      userMessageId = created.messages[0].id;
      createdConversation = true;
    }

    let rolledBack = false;

    // Undo the user's turn when the AI call fails, so a retry does not stack two
    // consecutive user messages and the sidebar never shows an empty conversation.
    rollbackTurn = async () => {
      try {
        if (createdConversation) {
          await prisma.conversation.delete({
            where: { id: conversationId },
          });
        } else {
          await prisma.message.delete({
            where: { id: userMessageId },
          });
        }

        rolledBack = true;
      } catch {
        logError("chat.rollback_failed", { correlationId, conversationId });
      }
    };

    // Records genuine GPU consumption on a turn that is being rolled back. Only ever
    // called with usage the upstream actually reported — never an estimate.
    const recordUsageOnly = async (usage: ChatCompletion["usage"]) => {
      try {
        await prisma.usage.create({
          data: {
            userId: appUser.id,
            promptTokens: usage?.prompt_tokens ?? 0,
            completionTokens: usage?.completion_tokens ?? 0,
            totalTokens: usage?.total_tokens ?? 0,
            requestCount: 1,
          },
        });
      } catch {
        logError("chat.usage_record_failed", { correlationId });
      }
    };

    // Returning the conversation id lets the client resynchronise when the turn could
    // not be rolled back; a rolled-back new conversation reports null.
    const failure = (status: number, error: string, reason: string) =>
      Response.json(
        {
          error,
          reason,
          correlationId,
          conversationId:
            createdConversation && rolledBack ? null : conversationId,
        },
        { status }
      );

    const recentMessages = await prisma.message.findMany({
      where: {
        conversationId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: chatConfig.contextFetchLimit,
    });

    recentMessages.reverse();

    const { selected, usedChars } = selectContextWithinBudget(
      recentMessages,
      chatConfig.contextCharBudget
    );

    const aiMessages = selected.map((m) => ({
      role:
        m.role === "USER"
          ? "user"
          : m.role === "ASSISTANT"
            ? "assistant"
            : "system",
      content: m.content,
    }));

    // Two independent abort sources, combined: the application's own generation
    // deadline, and the client going away. `AbortSignal.any` propagates whichever
    // fires first to the upstream fetch.
    const timeoutController = new AbortController();
    timeoutTimer = setTimeout(
      () => timeoutController.abort(),
      chatConfig.upstreamTimeoutMs
    );

    const upstreamSignal = AbortSignal.any([
      timeoutController.signal,
      req.signal,
    ]);

    let response: Response;

    try {
      response = await fetch(
        `${upstream.baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${upstream.apiKey}`,
          },
          body: JSON.stringify({
            model: "innovera-ai",
            messages: aiMessages,
            max_tokens: 1500,
            temperature: 0.7,
            // Stable internal identifier for upstream attribution. Never the email
            // address or any other personally identifying field.
            user: appUser.id,
          }),
          cache: "no-store",
          signal: upstreamSignal,
        }
      );
    } catch (error) {
      const aborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");

      if (aborted && timeoutController.signal.aborted) {
        logError("chat.upstream_timeout", { correlationId, timeoutMs: chatConfig.upstreamTimeoutMs });
        await rollbackTurn();
        return failure(504, UPSTREAM_TIMEOUT, "timeout");
      }

      if (aborted && req.signal.aborted) {
        // The client stopped waiting. No usage was reported, so nothing is recorded —
        // see the known limitation documented in the Phase 2 notes.
        logWarn("chat.client_cancelled", { correlationId });
        await rollbackTurn();
        return failure(499, REQUEST_CANCELLED, "cancelled");
      }

      logError("chat.upstream_unreachable", {
          correlationId,
          name: error instanceof Error ? error.name : "unknown",
        });
      await rollbackTurn();
      return failure(502, UPSTREAM_UNAVAILABLE, "upstream");
    }

    // Status is checked before the body is parsed. Parsing first turned every non-JSON
    // upstream error into a generic 500 and left this branch unreachable.
    if (!response.ok) {
      let upstreamType: unknown = null;
      let upstreamCode: unknown = null;

      try {
        const errorBody = await response.json();
        upstreamType = errorBody?.error?.type ?? null;
        upstreamCode = errorBody?.error?.code ?? null;
      } catch {
        // Non-JSON upstream error body; the status alone is the signal.
      }

      logError("chat.upstream_error", {
          correlationId,
          status: response.status,
          type: upstreamType,
          code: upstreamCode,
        });

      await rollbackTurn();

      return failure(
        502,
        messageForUpstreamStatus(response.status),
        "upstream"
      );
    }

    let data: ChatCompletion;

    try {
      data = (await response.json()) as ChatCompletion;
    } catch {
      logError("chat.upstream_unparsable", { correlationId, status: response.status });

      await rollbackTurn();

      return failure(502, UPSTREAM_UNAVAILABLE, "upstream");
    }

    const rawAnswer = data?.choices?.[0]?.message?.content;
    const answer =
      typeof rawAnswer === "string" ? rawAnswer.trim() : "";

    // A null or empty completion used to be stored verbatim as an assistant message and
    // then replayed into the model's own context on every following turn.
    if (!answer) {
      logError("chat.empty_completion", { correlationId });

      await rollbackTurn();

      // The model still ran. When upstream reported real usage, it is recorded against
      // the quota even though the turn itself is discarded.
      if (data?.usage) {
        await recordUsageOnly(data.usage);
      }

      return failure(502, UPSTREAM_EMPTY, "upstream");
    }

    const usage = data?.usage ?? {};

    await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          role: "ASSISTANT",
          content: answer,
          promptTokens: usage.prompt_tokens ?? null,
          outputTokens: usage.completion_tokens ?? null,
        },
      }),
      prisma.usage.create({
        data: {
          userId: appUser.id,
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          requestCount: 1,
        },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);

    // The turn is committed; nothing after this point may undo it.
    rollbackTurn = null;

    logInfo("chat.completed", {
        correlationId,
        contextMessages: aiMessages.length,
        contextChars: usedChars,
        totalTokens: usage.total_tokens ?? null,
      });

    return Response.json({
      conversationId,
      title: conversationTitle,
      message: answer,
      usage,
    });
  } catch (error) {
    if (rollbackTurn) {
      await rollbackTurn();
    }

    logError("chat.unhandled_error", {
        correlationId,
        name: error instanceof Error ? error.name : "unknown",
      });

    return Response.json(
      { error: "Internal server error", correlationId },
      { status: 500 }
    );
  } finally {
    // The upstream operation has terminated one way or another by the time any return
    // path unwinds to here, so the slot is genuinely free.
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    if (releaseConcurrencySlot) {
      releaseConcurrencySlot();
    }
  }
}
