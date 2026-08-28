"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

type Conversation = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  email: string;
  isAdmin: boolean;
};

type ConversationListBody = {
  conversations?: Conversation[];
};

type ConversationDetailBody = {
  conversation?: {
    id: string;
    messages: Array<{
      id: string;
      role: string;
      content: string;
    }>;
  };
};

type ChatSuccessBody = {
  conversationId: string;
  title: string | null;
  message: string;
};

type ChatErrorBody = {
  error?: string;
  reason?: string;
  correlationId?: string;
  conversationId?: string | null;
};

// A failing response often carries an HTML body rather than JSON. Parsing it before the
// status was checked masked the real status behind a JSON syntax error.
async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default function ChatInterface({
  email,
  isAdmin,
}: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  // Monotonic id for conversation-open requests. Only the newest may write state, so a
  // slower earlier click can no longer overwrite the result of a faster later one.
  const openRequestId = useRef(0);

  // Aborts the in-flight /api/chat request when the user presses Stop. See
  // stopGeneration() for exactly what this does and does not guarantee.
  const abortRef = useRef<AbortController | null>(null);

  // Non-error status line (e.g. cancellation). Kept separate from the message list so
  // it never fabricates conversation history the server does not have.
  const [notice, setNotice] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", {
        cache: "no-store",
      });

      if (!res.ok) return;

      const data = await readJson<ConversationListBody>(res);
      setConversations(data?.conversations || []);
    } catch {
      // Ignore sidebar refresh errors.
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [messages, loading]);

  function newChat() {
    if (loading || loadingHistory) return;

    // Invalidate any in-flight history load so it cannot repopulate the new chat.
    openRequestId.current += 1;

    setNotice(null);
    setConversationId(null);
    setMessages([]);
    setInput("");
  }

  async function openConversation(id: string) {
    if (loading || loadingHistory) return;

    const requestId = (openRequestId.current += 1);

    setNotice(null);
    setLoadingHistory(true);

    try {
      const res = await fetch(
        `/api/conversations/${id}`,
        {
          cache: "no-store",
        }
      );

      if (!res.ok) {
        const errorData = await readJson<ChatErrorBody>(res);

        throw new Error(
          errorData?.error ||
            `Unable to load conversation (${res.status})`
        );
      }

      const data = await readJson<ConversationDetailBody>(res);

      if (!data?.conversation) {
        throw new Error("Unable to load conversation");
      }

      // A newer open or a new chat has superseded this request.
      if (openRequestId.current !== requestId) return;

      setConversationId(data.conversation.id);

      setMessages(
        data.conversation.messages
          .filter(
            (m) =>
              m.role === "USER" ||
              m.role === "ASSISTANT"
          )
          .map((m) => ({
            id: m.id,
            role:
              m.role === "USER"
                ? ("user" as const)
                : ("assistant" as const),
            content: m.content,
          }))
      );
    } catch (error) {
      console.error(error);
    } finally {
      if (openRequestId.current === requestId) {
        setLoadingHistory(false);
      }
    }
  }

  async function sendMessage() {
    const text = input.trim();

    // Sending while a conversation is still loading used to persist the message into
    // the previous conversation while the screen already showed the new one.
    if (!text || loading || loadingHistory) return;

    setNotice(null);
    setInput("");

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: text,
      },
    ]);

    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          conversationId,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorData = await readJson<ChatErrorBody>(res);

        // The server returns the id when it could not undo the turn, so the next send
        // continues that conversation instead of starting a second one.
        if (errorData?.conversationId) {
          setConversationId(errorData.conversationId);
        }

        if (res.status === 401) {
          throw new Error(
            "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่"
          );
        }

        if (!errorData?.error) {
          throw new Error(`Request failed (${res.status})`);
        }

        throw new Error(
          errorData.correlationId
            ? `${errorData.error} (ref: ${errorData.correlationId})`
            : errorData.error
        );
      }

      const data = await readJson<ChatSuccessBody>(res);

      if (!data) {
        throw new Error(
          "ไม่สามารถอ่านคำตอบจาก INNOVERA AI ได้"
        );
      }

      if (!conversationId) {
        setConversationId(data.conversationId);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.message,
        },
      ]);
    } catch (error) {
      // A user-initiated cancellation is not a failure and must not be rendered as one.
      if (error instanceof Error && error.name === "AbortError") {
        // The server rolls the turn back on disconnect, so drop the optimistic bubble
        // and hand the text back instead of leaving an unanswered message on screen.
        setMessages((prev) => prev.slice(0, -1));
        setInput(text);
        setNotice("ยกเลิกคำขอแล้ว");
      } else {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unknown error";

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              "เกิดข้อผิดพลาดในการเชื่อมต่อ INNOVERA AI\n\n" +
              errorMessage,
          },
        ]);
      }
    } finally {
      abortRef.current = null;
      setLoading(false);

      // Always resync: on failure or cancellation the server may have rolled the turn
      // back, so the sidebar must reflect server truth, not the optimistic update.
      void loadConversations();
    }
  }

  // Aborts the browser's request. Whether the upstream generation itself stops is a
  // server-side concern; the wording here deliberately claims only that the request was
  // cancelled. See the Phase 2 notes on req.signal propagation.
  function stopGeneration() {
    abortRef.current?.abort();
  }

  return (
    <main className="flex h-screen overflow-hidden bg-zinc-950 text-white">
      <aside className="flex w-72 shrink-0 flex-col border-r border-white/10 p-4">
        <div className="mb-6">
          <h1 className="font-semibold">
            INNOVERA AI
          </h1>
          <p className="text-xs text-white/40">
            Private AI
          </p>
        </div>

        <button
          type="button"
          onClick={newChat}
          className="w-full rounded-xl border border-white/10 px-4 py-3 text-left hover:bg-white/5"
        >
          + New Chat
        </button>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
          <p className="mb-3 text-xs uppercase tracking-wider text-white/30">
            Chat History
          </p>

          {conversations.length === 0 ? (
            <p className="text-sm text-white/30">
              No conversations yet.
            </p>
          ) : (
            <div className="space-y-1">
              {conversations.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  onClick={() =>
                    void openConversation(
                      conversation.id
                    )
                  }
                  className={
                    conversation.id ===
                    conversationId
                      ? "w-full truncate rounded-lg bg-white/10 px-3 py-2 text-left text-sm"
                      : "w-full truncate rounded-lg px-3 py-2 text-left text-sm text-white/60 hover:bg-white/5 hover:text-white"
                  }
                >
                  {conversation.title ||
                    "New conversation"}
                </button>
              ))}
            </div>
          )}
        </div>

        {isAdmin && (
          <Link
            href="/admin"
            className="mt-4 rounded-xl border border-white/10 px-4 py-3 text-sm hover:bg-white/5"
          >
            Admin
          </Link>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-6">
          <div>
            <span className="font-medium">
              innovera-ai
            </span>

            <span className="ml-3 text-xs text-white/40">
              {email}
            </span>
          </div>

          <UserButton />
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-6 py-8">
            {loadingHistory ? (
              <div className="flex h-full items-center justify-center text-white/40">
                Loading conversation...
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <h2 className="text-3xl font-semibold">
                    How can I help you today?
                  </h2>
                  <p className="mt-3 text-sm text-white/40">
                    INNOVERA Private AI
                  </p>
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-7">
                {messages.map((message, index) => (
                  <div
                    key={message.id || index}
                    className={
                      message.role === "user"
                        ? "flex justify-end"
                        : "flex justify-start"
                    }
                  >
                    <div
                      className={
                        message.role === "user"
                          ? "max-w-[80%] whitespace-pre-wrap rounded-2xl bg-white px-4 py-3 text-black"
                          : "max-w-[90%] whitespace-pre-wrap leading-7 text-white"
                      }
                    >
                      {message.content}
                    </div>
                  </div>
                ))}

                {loading && (
                  <div className="text-sm text-white/50">
                    INNOVERA AI กำลังตอบ...
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            )}
          </div>

          <div className="border-t border-white/10 p-5">
            {notice && (
              <div className="mx-auto mb-3 max-w-3xl text-sm text-white/50">
                {notice}
              </div>
            )}

            <div className="mx-auto max-w-3xl rounded-2xl border border-white/15 bg-white/5 p-4">
              <textarea
                value={input}
                onChange={(e) =>
                  setInput(e.target.value)
                }
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder="Ask INNOVERA AI..."
                className="min-h-20 w-full resize-none bg-transparent text-white outline-none placeholder:text-white/30"
              />

              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-white/30">
                  Enter ส่ง • Shift + Enter
                  ขึ้นบรรทัดใหม่
                </span>

                {loading ? (
                  <button
                    type="button"
                    onClick={stopGeneration}
                    className="rounded-lg border border-white/30 px-5 py-2 font-medium text-white hover:bg-white/10"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      void sendMessage()
                    }
                    disabled={
                      loadingHistory ||
                      !input.trim()
                    }
                    className="rounded-lg bg-white px-5 py-2 font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
