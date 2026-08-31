"use client";

import type { AttachedFile } from "@/components/chat/types";
import { statusOf, contextNoteFor } from "@/lib/files/status";

type Props = {
  /** Selected for the next message — these are what the model will read. */
  active: AttachedFile[];
  /** Associated with the conversation but NOT selected — these contribute nothing. */
  inactive: AttachedFile[];
  onDeactivate: (fileId: string) => void;
  onActivate: (fileId: string) => void;
  onDetach: (fileId: string) => void;
  disabled: boolean;
};

/**
 * The two attachment rows.
 *
 * They are visually and verbally distinct because the difference is not cosmetic: an
 * ACTIVE file is read by the model on the next message, an INACTIVE one is not. A single
 * undifferentiated row of chips would leave a user unable to tell whether their question
 * is grounded in a document or not, which is exactly the confusion that makes a model's
 * confident answer dangerous.
 *
 * Each active chip also states the extraction status honestly, including the cases where
 * the AI will not see the content even though the file is selected.
 */
export default function AttachmentChips({
  active,
  inactive,
  onDeactivate,
  onActivate,
  onDetach,
  disabled,
}: Props) {
  if (active.length === 0 && inactive.length === 0) return null;

  return (
    <div className="mx-auto mb-2 max-w-3xl space-y-2">
      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs text-white/45">แนบในคำถามนี้:</span>

          {active.map((file) => {
            const presentation = statusOf(file.extractStatus);
            const note = contextNoteFor(file);

            return (
              <span
                key={file.id}
                className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-white/25 bg-white/10 py-1 pl-3 pr-1 text-xs"
              >
                <span className="min-w-0 truncate" title={file.filename}>
                  {file.filename}
                </span>

                <span className={`shrink-0 ${presentation.tone}`}>{presentation.label}</span>

                {note && <span className="shrink-0 text-white/35">· {note}</span>}

                {/* Deselects for the next message. The file stays in the conversation. */}
                <button
                  type="button"
                  onClick={() => onDeactivate(file.id)}
                  disabled={disabled}
                  aria-label={`Remove ${file.filename} from this message`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 sm:h-7 sm:w-7"
                >
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            );
          })}
        </div>
      )}

      {inactive.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Says plainly that these are NOT being read, so an unselected file cannot be
              mistaken for context the answer was grounded in. */}
          <span className="shrink-0 text-xs text-white/30">
            ไฟล์ในบทสนทนานี้ (ยังไม่ได้ใช้):
          </span>

          {inactive.map((file) => (
            <span
              key={file.id}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-dashed border-white/15 py-1 pl-1 pr-1 text-xs text-white/45"
            >
              <button
                type="button"
                onClick={() => onActivate(file.id)}
                disabled={disabled}
                aria-label={`Use ${file.filename} in this message`}
                className="flex min-h-11 min-w-0 items-center rounded-full px-2 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-7"
              >
                <span className="min-w-0 truncate" title={file.filename}>
                  {file.filename}
                </span>
              </button>

              <button
                type="button"
                onClick={() => onDetach(file.id)}
                disabled={disabled}
                aria-label={`Remove ${file.filename} from this conversation`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/35 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 sm:h-7 sm:w-7"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
