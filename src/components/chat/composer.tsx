"use client";

import { useEffect, useRef } from "react";
import type { AttachedFile } from "@/components/chat/types";
import AttachmentChips from "@/components/chat/attachment-chips";

type Props = {
  input: string;
  setInput: (value: string) => void;
  loading: boolean;
  loadingHistory: boolean;
  notice: string | null;
  /** Selected for the next message. */
  active: AttachedFile[];
  /** Associated with the conversation but not selected. */
  inactive: AttachedFile[];
  onSend: () => void;
  onStop: () => void;
  onDeactivate: (fileId: string) => void;
  onActivate: (fileId: string) => void;
  onDetach: (fileId: string) => void;
  onOpenPicker: () => void;
};

export default function Composer({
  input,
  setInput,
  loading,
  loadingHistory,
  notice,
  active,
  inactive,
  onSend,
  onStop,
  onDeactivate,
  onActivate,
  onDetach,
  onOpenPicker,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the composer up to a bounded height, after which the textarea itself
  // scrolls. Height is reset to "auto" first: without that, scrollHeight can only ever
  // grow, so the box would never shrink back when text is deleted.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  return (
    // env(safe-area-inset-bottom) keeps the composer clear of the iOS home indicator.
    // It resolves to 0 everywhere else, so no other target changes.
    <div className="shrink-0 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-5">
      {notice && (
        <div className="mx-auto mb-3 max-w-3xl text-sm text-white/50">{notice}</div>
      )}

      <AttachmentChips
        active={active}
        inactive={inactive}
        onDeactivate={onDeactivate}
        onActivate={onActivate}
        onDetach={onDetach}
        disabled={loading}
      />

      <div className="mx-auto max-w-3xl rounded-2xl border border-white/15 bg-white/5 p-3 sm:p-4">
        {/*
          items-end so the button stays aligned to the bottom of a grown textarea.
          min-w-0 on the textarea is what actually prevents the overflow: a flex item
          defaults to min-width:auto, so it refuses to shrink below its content and
          pushes the button outside the container instead.
        */}
        <div className="flex items-end gap-2 sm:block">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
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
              onClick={onStop}
              className="h-11 shrink-0 rounded-lg border border-white/30 px-4 font-medium text-white hover:bg-white/10 sm:hidden"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSend()}
              disabled={loadingHistory || !input.trim()}
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
            Enter ส่ง • Shift + Enter ขึ้นบรรทัดใหม่
          </span>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onOpenPicker}
              disabled={loading}
              className="shrink-0 rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              แนบไฟล์
            </button>

            {loading ? (
              <button
                type="button"
                onClick={onStop}
                className="shrink-0 rounded-lg border border-white/30 px-5 py-2 font-medium text-white hover:bg-white/10"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSend()}
                disabled={loadingHistory || !input.trim()}
                className="shrink-0 rounded-lg bg-white px-5 py-2 font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </div>

        {/* Mobile attach control. The desktop one lives in the hint row above, which is
            hidden below sm, so this row carries it instead — kept on its own line so it
            can never compete for width with the textarea and Send. */}
        <div className="mt-2 flex sm:hidden">
          <button
            type="button"
            onClick={onOpenPicker}
            disabled={loading}
            className="min-h-11 shrink-0 rounded-lg border border-white/20 px-4 text-sm text-white/80 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            แนบไฟล์
          </button>
        </div>
      </div>
    </div>
  );
}
