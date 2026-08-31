import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user || user.status !== "ACTIVE") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await context.params;

  const conversation = await prisma.conversation.findFirst({
    where: {
      id,
      userId: user.id,
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
        },
      },
      // Attachments travel with the conversation so reopening it restores the composer's
      // chips without a second round trip. Metadata only — extractedText is never
      // selected here, so file content has no path to the browser through this endpoint.
      files: {
        orderBy: [{ createdAt: "asc" }, { fileId: "asc" }],
        select: {
          file: {
            select: {
              id: true,
              filename: true,
              mimeType: true,
              sizeBytes: true,
              extractStatus: true,
              extractReason: true,
              extractTruncated: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });

  if (!conversation) {
    return Response.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  // Flattened so the client sees a list of files rather than a list of join rows.
  const { files, ...rest } = conversation;

  return Response.json({
    conversation: { ...rest, attachments: files.map((f) => f.file) },
  });
}
