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

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", {
        cache: "no-store",
      });

      if (!res.ok) return;

      const data = await res.json();
      setConversations(data.conversations || []);
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
    if (loading) return;

    setConversationId(null);
    setMessages([]);
    setInput("");
  }

  async function openConversation(id: string) {
    if (loading) return;

    setLoadingHistory(true);

    try {
      const res = await fetch(
        `/api/conversations/${id}`,
        {
          cache: "no-store",
        }
      );

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          data?.error || "Unable to load conversation"
        );
      }

      setConversationId(data.conversation.id);

      setMessages(
        data.conversation.messages
          .filter(
            (m: { role: string }) =>
              m.role === "USER" ||
              m.role === "ASSISTANT"
          )
          .map(
            (m: {
              id: string;
              role: string;
              content: string;
            }) => ({
              id: m.id,
              role:
                m.role === "USER"
                  ? "user"
                  : "assistant",
              content: m.content,
            })
          )
      );
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function sendMessage() {
    const text = input.trim();

    if (!text || loading) return;

    setInput("");

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: text,
      },
    ]);

    setLoading(true);

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
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          data?.error || "Request failed"
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

      await loadConversations();
    } catch (error) {
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
    } finally {
      setLoading(false);
    }
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

                <button
                  type="button"
                  onClick={() =>
                    void sendMessage()
                  }
                  disabled={
                    loading || !input.trim()
                  }
                  className="rounded-lg bg-white px-5 py-2 font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {loading
                    ? "Sending..."
                    : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
