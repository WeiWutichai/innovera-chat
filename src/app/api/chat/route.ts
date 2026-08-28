import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

const MAX_CONTEXT_MESSAGES = 20;

export async function POST(req: Request) {
  try {
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

    const body = await req.json();

    const message =
      typeof body.message === "string"
        ? body.message.trim()
        : "";

    const requestedConversationId =
      typeof body.conversationId === "string"
        ? body.conversationId
        : null;

    if (!message) {
      return Response.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    if (message.length > 20000) {
      return Response.json(
        { error: "Message is too long" },
        { status: 400 }
      );
    }

    let conversation;

    if (requestedConversationId) {
      conversation = await prisma.conversation.findFirst({
        where: {
          id: requestedConversationId,
          userId: appUser.id,
        },
      });

      if (!conversation) {
        return Response.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }
    } else {
      const title =
        message.length > 60
          ? message.slice(0, 60) + "..."
          : message;

      conversation = await prisma.conversation.create({
        data: {
          userId: appUser.id,
          title,
        },
      });
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content: message,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    const recentMessages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: MAX_CONTEXT_MESSAGES,
    });

    recentMessages.reverse();

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

    const data = await response.json();

    if (!response.ok) {
      console.error("LiteLLM error:", data);

      return Response.json(
        {
          error:
            data?.error?.message ||
            "AI service error",
        },
        { status: 502 }
      );
    }

    const answer =
      data?.choices?.[0]?.message?.content ||
      "ไม่พบคำตอบจาก AI";

    const usage = data?.usage || {};

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: answer,
        promptTokens: usage.prompt_tokens ?? null,
        outputTokens: usage.completion_tokens ?? null,
      },
    });

    await prisma.usage.create({
      data: {
        userId: appUser.id,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        requestCount: 1,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    return Response.json({
      conversationId: conversation.id,
      title: conversation.title,
      message: answer,
      usage,
    });
  } catch (error) {
    console.error("Chat API error:", error);

    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
