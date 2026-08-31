"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import ChatHeader from "@/components/chat/chat-header";
import ConversationSidebar from "@/components/chat/conversation-sidebar";
import MessageList from "@/components/chat/message-list";
import Composer from "@/components/chat/composer";
import AttachmentPicker from "@/components/chat/attachment-picker";
import { useAttachments } from "@/components/chat/use-attachments";
import {
  readJson,
  type AttachedFile,
  type ChatErrorBody,
  type ChatMessage,
  type Conversation,
} from "@/components/chat/types";

/**
 * Chat orchestrator.
 *
 * Holds the state and the network calls; every piece of markup lives in a focused child
 * (sidebar, message list, composer, picker). The split is what keeps file attachments
 * from turning this into a single unreviewable component.
 */

type Props = {
  email: string;
  isAdmin: boolean;
};

type ConversationListBody = { conversations?: Conversation[] };

type ConversationDetailBody = {
  conversation?: {
    id: string;
    messages: Array<{ id: string; role: string; content: string }>;
    attachments?: AttachedFile[];
  };
};

type ChatSuccessBody = {
  conversationId: string;
  title: string | null;
  message: string;
};

// Pure fetch: no React state. Returns null when the refresh fails, so callers keep
// the list they already have instead of blanking the sidebar on a transient error.
async function fetchConversations(): Promise<Conversation[] | null> {
  try {
    const res = await fetch("/api/conversations", { cache: "no-store" });
    if (!res.ok) return null;

    const data = await readJson<ConversationListBody>(res);
    return data?.conversations || [];
  } catch {
    return null;
  }
}

export default function ChatInterface({ email, isAdmin }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // ASSOCIATED = everything ever attached to this conversation; ACTIVE = what the next
  // message will actually read. See use-attachments for why the two are separate.
  const {
    associated,
    active,
    inactive,
    activeIds,
    attach: attachFiles,
    activate,
    deactivate,
    detach,
    hydrate: hydrateAttachments,
    reset: resetAttachments,
    error: attachmentError,
  } = useAttachments(conversationId);

  const [pickerOpen, setPickerOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

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
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Body scroll lock while the drawer covers the page, restoring whatever was there.
  useEffect(() => {
    if (!sidebarOpen) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, [sidebarOpen]);

  function newChat() {
    if (loading || loadingHistory) return;

    setSidebarOpen(false);

    // Invalidate any in-flight history load so it cannot repopulate the new chat.
    openRequestId.current += 1;

    setNotice(null);
    setConversationId(null);
    setMessages([]);
    setInput("");
    resetAttachments();
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
      const res = await fetch(`/api/conversations/${id}`, { cache: "no-store" });

      if (!res.ok) {
        const errorData = await readJson<ChatErrorBody>(res);
        throw new Error(errorData?.error || `Unable to load conversation (${res.status})`);
      }

      const data = await readJson<ConversationDetailBody>(res);

      if (!data?.conversation) throw new Error("Unable to load conversation");

      // A newer open or a new chat has superseded this request.
      if (openRequestId.current !== requestId) return;

      setConversationId(data.conversation.id);

      setMessages(
        data.conversation.messages
          .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
          .map((m) => ({
            id: m.id,
            role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
            content: m.content,
          }))
      );

      // The association is restored so the user can see and re-select it. NOTHING is
      // made active: reopening a conversation must not silently re-send its documents to
      // the model on the next question.
      hydrateAttachments(data.conversation.attachments ?? []);
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

    setMessages((prev) => [...prev, { role: "user", content: text }]);

    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // ONLY the active selection. Associated-but-inactive files are deliberately absent,
    // so they contribute nothing to this turn. The server re-authorizes every id, so this
    // is a request, never an assertion of what may be read.
    const fileIds = active.map((f) => f.id);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversationId,
          ...(fileIds.length > 0 ? { fileIds } : {}),
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
          throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
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

      if (!data) throw new Error("ไม่สามารถอ่านคำตอบจาก INNOVERA AI ได้");

      if (!conversationId) {
        setConversationId(data.conversationId);
      }

      setMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
    } catch (error) {
      // A user-initiated cancellation is not a failure and must not be rendered as one.
      if (error instanceof Error && error.name === "AbortError") {
        // The server rolls the turn back on disconnect, so drop the optimistic bubble
        // and hand the text back instead of leaving an unanswered message on screen.
        setMessages((prev) => prev.slice(0, -1));
        setInput(text);
        setNotice("ยกเลิกคำขอแล้ว");
      } else {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "เกิดข้อผิดพลาดในการเชื่อมต่อ INNOVERA AI\n\n" + errorMessage,
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

      <ConversationSidebar
        email={email}
        isAdmin={isAdmin}
        conversations={conversations}
        conversationId={conversationId}
        sidebarOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewChat={newChat}
        onOpenConversation={(id) => void openConversation(id)}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          email={email}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
            <MessageList
              messages={messages}
              associated={associated}
              activeIds={activeIds}
              loading={loading}
              loadingHistory={loadingHistory}
              bottomRef={bottomRef}
            />
          </div>

          <Composer
            input={input}
            setInput={setInput}
            loading={loading}
            loadingHistory={loadingHistory}
            notice={notice ?? attachmentError}
            active={active}
            inactive={inactive}
            onSend={() => void sendMessage()}
            onStop={stopGeneration}
            onDeactivate={deactivate}
            onActivate={activate}
            onDetach={(id) => void detach(id)}
            onOpenPicker={() => setPickerOpen(true)}
          />
        </div>
      </section>

      {/* Mounted only while open, so it starts from clean state every time and holds
          no file list in memory when closed. */}
      {pickerOpen && (
        <AttachmentPicker
          activeIds={activeIds}
          onClose={() => setPickerOpen(false)}
          onAttach={(ids) => void attachFiles(ids)}
        />
      )}
    </main>
  );
}
