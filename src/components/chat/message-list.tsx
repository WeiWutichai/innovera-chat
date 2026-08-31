"use client";

import type { RefObject } from "react";
import type { ChatMessage, AttachedFile } from "@/components/chat/types";
import { statusOf } from "@/lib/files/status";

type Props = {
  messages: ChatMessage[];
  /** Every file associated with this conversation. */
  associated: AttachedFile[];
  /** Which of them the next message will actually read. */
  activeIds: string[];
  loading: boolean;
  loadingHistory: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
};

export default function MessageList({
  messages,
  associated,
  activeIds,
  loading,
  loadingHistory,
  bottomRef,
}: Props) {
  if (loadingHistory) {
    return (
      <div className="flex h-full items-center justify-center text-white/40">
        Loading conversation...
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-semibold sm:text-3xl">How can I help you today?</h2>
          <p className="mt-3 text-sm text-white/40">INNOVERA Private AI</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 sm:space-y-7">
      {/* The conversation's file history, so reopening it does not leave the answers
          looking like they came from nowhere. Read-only: selecting what the NEXT message
          reads happens in the composer, and this row marks which files that currently is
          so the two views can never disagree. */}
      {associated.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-white/40">
          <span className="shrink-0">ไฟล์ในบทสนทนานี้:</span>
          {associated.map((file) => (
            <span
              key={file.id}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1"
            >
              <span className="min-w-0 truncate">{file.filename}</span>
              <span className={`shrink-0 ${statusOf(file.extractStatus).tone}`}>
                {statusOf(file.extractStatus).label}
              </span>
              {activeIds.includes(file.id) && (
                <span className="shrink-0 text-white/60">· ใช้ในคำถามนี้</span>
              )}
            </span>
          ))}
        </div>
      )}

      {messages.map((message, index) => (
        <div
          key={message.id || index}
          className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
        >
          {/*
            break-words is overflow-wrap:break-word — it breaks only tokens that cannot
            fit on a line of their own. word-break:break-all is deliberately NOT used: it
            would split ordinary Thai and English mid-word on every line.
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

      {loading && <div className="text-sm text-white/50">INNOVERA AI กำลังตอบ...</div>}

      <div ref={bottomRef} />
    </div>
  );
}
