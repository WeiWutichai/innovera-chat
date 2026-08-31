"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import type { Conversation } from "@/components/chat/types";

type Props = {
  email: string;
  isAdmin: boolean;
  conversations: Conversation[];
  conversationId: string | null;
  sidebarOpen: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
};

/**
 * One element, two behaviours. Below lg it is a fixed, translated drawer; at lg and above
 * `lg:static lg:translate-x-0` returns it to the normal flow as the permanent column, so
 * the desktop layout is unchanged.
 *
 * Width is min(85vw, 320px) rather than a fraction: w-72 (288px) was 77% of a 375px
 * iPhone, which squeezed the chat column to ~87px and forced text to wrap character by
 * character.
 */
export default function ConversationSidebar({
  email,
  isAdmin,
  conversations,
  conversationId,
  sidebarOpen,
  onClose,
  onNewChat,
  onOpenConversation,
}: Props) {
  return (
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
          <h1 className="font-semibold">INNOVERA AI</h1>
          <p className="text-xs text-white/40">Private AI</p>
        </div>

        {/* 44px touch target, drawer-only. */}
        <button
          type="button"
          onClick={onClose}
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
        onClick={onNewChat}
        className="min-h-11 w-full rounded-xl border border-white/10 px-4 py-3 text-left hover:bg-white/5"
      >
        + New Chat
      </button>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
        <p className="mb-3 text-xs uppercase tracking-wider text-white/30">Chat History</p>

        {conversations.length === 0 ? (
          <p className="text-sm text-white/30">No conversations yet.</p>
        ) : (
          <div className="space-y-1">
            {conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                onClick={() => onOpenConversation(conversation.id)}
                className={
                  conversation.id === conversationId
                    ? "min-h-11 w-full truncate rounded-lg bg-white/10 px-3 py-2 text-left text-sm"
                    : "min-h-11 w-full truncate rounded-lg px-3 py-2 text-left text-sm text-white/60 hover:bg-white/5 hover:text-white"
                }
              >
                {conversation.title || "New conversation"}
              </button>
            ))}
          </div>
        )}
      </div>

      <Link
        href="/files"
        className="mt-4 flex min-h-11 items-center rounded-xl border border-white/10 px-4 py-3 text-sm hover:bg-white/5"
      >
        Files
      </Link>

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
        <span className="min-w-0 truncate text-xs text-white/40">{email}</span>
      </div>
    </aside>
  );
}
