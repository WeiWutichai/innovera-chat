import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

// One more than the 20-message window, so trimming a leading assistant turn cannot
// shrink the effective context below the intended size.
const CONTEXT_FETCH_LIMIT = 21;
const MAX_MESSAGE_LENGTH = 20000;

const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
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
// provider, host, model and internal configuration detail no end user should see.
const UPSTREAM_BUSY =
  "ระบบ AI มีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกครั้ง";
const UPSTREAM_UNAVAILABLE =
  "ระบบ AI ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง";
const UPSTREAM_EMPTY =
  "ระบบ AI ไม่ได้ส่งคำตอบกลับมา กรุณาลองใหม่อีกครั้ง";

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

  try {
    if (isCrossSiteRequest(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const { userId } = await auth();

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
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
        console.error(
          "chat.rollback_failed",
          JSON.stringify({ correlationId, conversationId })
        );
      }
    };

    // Returning the conversation id lets the client resynchronise when the turn could
    // not be rolled back; a rolled-back new conversation reports null.
    const failure = (status: number, error: string) =>
      Response.json(
        {
          error,
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
      take: CONTEXT_FETCH_LIMIT,
    });

    recentMessages.reverse();

    // The current user row is written before this read, so an otherwise-full window
    // would begin mid-turn on an assistant message from the 11th turn onward.
    while (
      recentMessages.length > 1 &&
      recentMessages[0].role !== "USER"
    ) {
      recentMessages.shift();
    }

    const aiMessages = recentMessages.map((m) => ({
      role:
        m.role === "USER"
          ? "user"
          : m.role === "ASSISTANT"
            ? "assistant"
            : "system",
      content: m.content,
    }));

    const response = await fetch(
      `${process.env.LITELLM_BASE_URL}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LITELLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: "innovera-ai",
          messages: aiMessages,
          max_tokens: 1500,
          temperature: 0.7,
        }),
        cache: "no-store",
      }
    );

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

      console.error(
        "chat.upstream_error",
        JSON.stringify({
          correlationId,
          status: response.status,
          type: upstreamType,
          code: upstreamCode,
        })
      );

      await rollbackTurn();

      return failure(502, messageForUpstreamStatus(response.status));
    }

    let data: ChatCompletion;

    try {
      data = (await response.json()) as ChatCompletion;
    } catch {
      console.error(
        "chat.upstream_unparsable",
        JSON.stringify({ correlationId, status: response.status })
      );

      await rollbackTurn();

      return failure(502, UPSTREAM_UNAVAILABLE);
    }

    const rawAnswer = data?.choices?.[0]?.message?.content;
    const answer =
      typeof rawAnswer === "string" ? rawAnswer.trim() : "";

    // A null or empty completion used to be stored verbatim as an assistant message and
    // then replayed into the model's own context on every following turn.
    if (!answer) {
      console.error(
        "chat.empty_completion",
        JSON.stringify({ correlationId })
      );

      await rollbackTurn();

      return failure(502, UPSTREAM_EMPTY);
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

    console.error(
      "chat.unhandled_error",
      JSON.stringify({
        correlationId,
        name: error instanceof Error ? error.name : "unknown",
      })
    );

    return Response.json(
      { error: "Internal server error", correlationId },
      { status: 500 }
    );
  }
}
