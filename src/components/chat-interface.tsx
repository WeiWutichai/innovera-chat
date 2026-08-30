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

// Pure fetch: no React state. Returns null when the refresh fails, so callers keep
// the list they already have instead of blanking the sidebar on a transient error.
async function fetchConversations(): Promise<Conversation[] | null> {
  try {
    const res = await fetch("/api/conversations", {
      cache: "no-store",
    });

    if (!res.ok) return null;

    const data = await readJson<ConversationListBody>(res);
    return data?.conversations || [];
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Drawer state. Only meaningful below the lg breakpoint: at lg and above the sidebar
  // is statically positioned and this value cannot hide it.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Monotonic id for conversation-open requests. Only the newest may write state, so a
  // slower earlier click can no longer overwrite the result of a faster later one.
  const openRequestId = useRef(0);

  // Aborts the in-flight /api/chat request when the user presses Stop. See
  // stopGeneration() for exactly what this does and does not guarantee.
  const abortRef = useRef<AbortController | null>(null);

  // Non-error status line (e.g. cancellation). Kept separate from the message list so
  // it never fabricates conversation history the server does not have.
  const [notice, setNotice] = useState<string | null>(null);

  const refreshConversations = useCallback(async () => {
    const list = await fetchConversations();
    if (list) setConversations(list);
  }, []);

  // The state update happens in the async continuation, never synchronously in the
  // effect body. The cancelled flag drops a late response after unmount.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const list = await fetchConversations();
      if (!cancelled && list) setConversations(list);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [messages, loading]);

  // Escape closes the drawer. Bound only while it is open so the handler is not
  // attached for the entire session, and removed on unmount either way.
  useEffect(() => {
    if (!sidebarOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  // Stops the page behind the drawer from scrolling. The previous value is restored
  // rather than hardcoded to "", so this cannot clobber a style set elsewhere.
  useEffect(() => {
    if (!sidebarOpen) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, [sidebarOpen]);

  // Auto-grow the composer up to a bounded height, after which the textarea itself
  // scrolls. Height is reset to "auto" first: without that, scrollHeight can only ever
  // grow, so the box would never shrink back when text is deleted.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  function newChat() {
    if (loading || loadingHistory) return;

    setSidebarOpen(false);

    // Invalidate any in-flight history load so it cannot repopulate the new chat.
    openRequestId.current += 1;

    setNotice(null);
    setConversationId(null);
    setMessages([]);
    setInput("");
  }

  async function openConversation(id: string) {
    if (loading || loadingHistory) return;

    // Closed immediately, not after the fetch resolves: waiting would leave the drawer
    // covering the conversation the user just chose for the whole load.
    setSidebarOpen(false);

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
      void refreshConversations();
    }
  }

  // Aborts the browser's request. Whether the upstream generation itself stops is a
  // server-side concern; the wording here deliberately claims only that the request was
  // cancelled. See the Phase 2 notes on req.signal propagation.
  function stopGeneration() {
    abortRef.current?.abort();
  }

  return (
    // h-dvh, not h-screen: 100vh on iOS Safari is the height with the address bar
    // HIDDEN, so the composer sat below the fold until the bar collapsed. The dynamic
    // unit tracks the visible viewport instead.
    <main className="flex h-dvh overflow-hidden bg-zinc-950 text-white">
      {/* Backdrop. Rendered only while the drawer is open, and only below lg. */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      )}

      {/*
        One element, two behaviours. Below lg it is a fixed, translated drawer; at lg
        and above `lg:static lg:translate-x-0` returns it to the normal flow as the
        permanent column, so the desktop layout is unchanged.

        Width is min(85vw, 320px) rather than a fraction: w-72 (288px) was 77% of a
        375px iPhone, which is what squeezed the chat column to ~87px and forced text
        to wrap character by character.
      */}
      <aside
        id="conversation-drawer"
        aria-label="Conversation history"
        aria-hidden={!sidebarOpen}
        className={`fixed inset-y-0 left-0 z-50 flex w-[min(85vw,320px)] flex-col border-r border-white/10 bg-zinc-950 p-4 transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-72 lg:shrink-0 lg:translate-x-0 lg:transition-none ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-6 flex items-start justify-between gap-2">
          <div>
            <h1 className="font-semibold">
              INNOVERA AI
            </h1>
            <p className="text-xs text-white/40">
              Private AI
            </p>
          </div>

          {/* 44px touch target, drawer-only. */}
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close conversation history"
            className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/5 hover:text-white lg:hidden"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <button
          type="button"
          onClick={newChat}
          className="min-h-11 w-full rounded-xl border border-white/10 px-4 py-3 text-left hover:bg-white/5"
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
                      ? "min-h-11 w-full truncate rounded-lg bg-white/10 px-3 py-2 text-left text-sm"
                      : "min-h-11 w-full truncate rounded-lg px-3 py-2 text-left text-sm text-white/60 hover:bg-white/5 hover:text-white"
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
            className="mt-4 flex min-h-11 items-center rounded-xl border border-white/10 px-4 py-3 text-sm hover:bg-white/5"
          >
            Admin
          </Link>
        )}

        {/* The account control lives in the drawer on mobile; the header keeps it on
            desktop, where there is room for it alongside the email. */}
        <div className="mt-4 flex items-center gap-3 border-t border-white/10 pt-4 lg:hidden">
          <UserButton />
          <span className="min-w-0 truncate text-xs text-white/40">
            {email}
          </span>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {/* px-4 on mobile, px-6 from sm. gap-3 keeps the title clear of both controls. */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4 sm:h-16 sm:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open conversation history"
            aria-expanded={sidebarOpen}
            aria-controls="conversation-drawer"
            className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/5 hover:text-white lg:hidden"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <span className="font-medium">
              innovera-ai
            </span>

            {/* The email is the element that made the narrow header unreadable, so it
                appears only where there is width for it. */}
            <span className="ml-3 hidden text-xs text-white/40 lg:inline">
              {email}
            </span>
          </div>

          <div className="hidden shrink-0 lg:block">
            <UserButton />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
            {loadingHistory ? (
              <div className="flex h-full items-center justify-center text-white/40">
                Loading conversation...
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <h2 className="text-2xl font-semibold sm:text-3xl">
                    How can I help you today?
                  </h2>
                  <p className="mt-3 text-sm text-white/40">
                    INNOVERA Private AI
                  </p>
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-6 sm:space-y-7">
                {messages.map((message, index) => (
                  <div
                    key={message.id || index}
                    className={
                      message.role === "user"
                        ? "flex justify-end"
                        : "flex justify-start"
                    }
                  >
                    {/*
                      break-words is overflow-wrap:break-word — it breaks only tokens
                      that cannot fit on a line of their own. word-break:break-all is
                      deliberately NOT used: it would split ordinary Thai and English
                      mid-word on every line.
                    */}
                    <div
                      className={
                        message.role === "user"
                          ? "max-w-[88%] break-words whitespace-pre-wrap rounded-2xl bg-white px-4 py-3 text-black sm:max-w-[80%]"
                          : "max-w-full break-words whitespace-pre-wrap leading-7 text-white sm:max-w-[90%]"
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

          {/* env(safe-area-inset-bottom) keeps the composer clear of the iOS home
              indicator. It resolves to 0 everywhere else, so no other target changes. */}
          <div className="shrink-0 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-5">
            {notice && (
              <div className="mx-auto mb-3 max-w-3xl text-sm text-white/50">
                {notice}
              </div>
            )}

            <div className="mx-auto max-w-3xl rounded-2xl border border-white/15 bg-white/5 p-3 sm:p-4">
              {/*
                items-end so the button stays aligned to the bottom of a grown textarea.
                min-w-0 on the textarea is what actually prevents the overflow: a flex
                item defaults to min-width:auto, so it refuses to shrink below its
                content and pushes the button outside the container instead.
              */}
              <div className="flex items-end gap-2 sm:block">
                <textarea
                  ref={textareaRef}
                  rows={1}
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
                  className="max-h-40 min-h-12 w-full min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-white outline-none placeholder:text-white/30 sm:min-h-20"
                />

                {/* Mobile: inline with the textarea. shrink-0 so it can never be
                    compressed or pushed out of the container. */}
                {loading ? (
                  <button
                    type="button"
                    onClick={stopGeneration}
                    className="h-11 shrink-0 rounded-lg border border-white/30 px-4 font-medium text-white hover:bg-white/10 sm:hidden"
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
                    className="h-11 shrink-0 rounded-lg bg-white px-4 font-medium text-black disabled:cursor-not-allowed disabled:opacity-40 sm:hidden"
                  >
                    Send
                  </button>
                )}
              </div>

              {/* Desktop keeps the original stacked layout: hint on the left, action on
                  the right. This row is the one that overflowed on mobile — the Thai
                  hint text cannot shrink — so it is hidden below sm. */}
              <div className="mt-3 hidden items-center justify-between gap-3 sm:flex">
                <span className="min-w-0 text-xs text-white/30">
                  Enter ส่ง • Shift + Enter
                  ขึ้นบรรทัดใหม่
                </span>

                {loading ? (
                  <button
                    type="button"
                    onClick={stopGeneration}
                    className="shrink-0 rounded-lg border border-white/30 px-5 py-2 font-medium text-white hover:bg-white/10"
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
                    className="shrink-0 rounded-lg bg-white px-5 py-2 font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
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
