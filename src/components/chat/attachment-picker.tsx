"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachedFile } from "@/components/chat/types";
import { readJson, formatBytes } from "@/components/chat/types";
import { statusOf, contextNoteFor, isImage } from "@/lib/files/status";

type Props = {
  /** Files already selected for the next message; re-picking them would be a no-op. */
  activeIds: string[];
  onClose: () => void;
  onAttach: (fileIds: string[]) => void;
};

type FileListBody = { files?: AttachedFile[] };

/**
 * Pure fetch: no React state. Returns null on failure so callers keep the list they
 * already have, and so effects can set state in their own async continuation rather
 * than synchronously in the effect body.
 */
async function fetchFiles(): Promise<AttachedFile[] | null> {
  try {
    const res = await fetch("/api/files", { cache: "no-store" });
    if (!res.ok) return null;

    const data = await readJson<FileListBody>(res);
    return data?.files ?? [];
  } catch {
    return null;
  }
}

/**
 * Picks files to attach: browse what is already uploaded, or upload something new
 * without leaving the conversation.
 *
 * Uploads go through the SAME /api/files endpoint the file workspace uses. There is no
 * second upload path, so the quota, size limits, MIME sniffing and extraction queueing
 * all apply here unchanged.
 */
export default function AttachmentPicker({ activeIds, onClose, onAttach }: Props) {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  // Starts true and is only ever cleared, so nothing sets state synchronously inside an
  // effect — the parent mounts this component fresh on each open, so there is no stale
  // state to reset in the first place.
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  /** Event-handler path (upload, manual retry). Effects use the IIFE form below. */
  const refresh = useCallback(async () => {
    const list = await fetchFiles();

    if (list) setFiles(list);
    else setError("ไม่สามารถโหลดรายการไฟล์ได้");

    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const list = await fetchFiles();
      if (cancelled) return;

      if (list) setFiles(list);
      else setError("ไม่สามารถโหลดรายการไฟล์ได้");

      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Extraction is asynchronous, so a file uploaded here starts as PENDING. Poll while
  // anything is still in flight so the status a user sees becomes true on its own.
  useEffect(() => {
    const pending = files.some(
      (f) => f.extractStatus === "PENDING" || f.extractStatus === "PROCESSING"
    );

    if (!pending) return;

    let cancelled = false;

    const timer = setTimeout(() => {
      void (async () => {
        const list = await fetchFiles();
        if (!cancelled && list) setFiles(list);
      })();
    }, 2500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [files]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function upload(list: FileList) {
    setUploading(true);
    setError(null);

    try {
      const form = new FormData();
      for (const file of Array.from(list)) form.append("files", file);

      const res = await fetch("/api/files", { method: "POST", body: form });

      if (!res.ok && res.status !== 207) {
        setError("อัปโหลดไม่สำเร็จ");
      }

      await refresh();
    } catch {
      setError("อัปโหลดไม่สำเร็จ");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6">
      {/* Full-height sheet on mobile, centred dialog from sm. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Attach files"
        className="flex max-h-[85dvh] w-full flex-col rounded-t-2xl border border-white/15 bg-zinc-950 sm:max-h-[70dvh] sm:max-w-2xl sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <h2 className="font-medium">แนบไฟล์</h2>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close file picker"
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/5 hover:text-white"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && <p className="mb-3 text-sm text-red-300">{error}</p>}

          {loading && files.length === 0 ? (
            <p className="py-8 text-center text-sm text-white/40">กำลังโหลด...</p>
          ) : files.length === 0 ? (
            <p className="py-8 text-center text-sm text-white/40">
              ยังไม่มีไฟล์ อัปโหลดไฟล์แรกได้เลย
            </p>
          ) : (
            <div className="space-y-1">
              {files.map((file) => {
                const presentation = statusOf(file.extractStatus);
                const note = contextNoteFor(file);
                // Only ACTIVE files are locked out. A file associated with the
                // conversation but not selected must remain pickable — that is how a
                // user brings an earlier attachment back into a later question.
                const alreadyActive = activeIds.includes(file.id);
                const checked = alreadyActive || selected.includes(file.id);

                return (
                  <label
                    key={file.id}
                    className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left ${
                      alreadyActive ? "opacity-50" : "hover:bg-white/5"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={alreadyActive}
                      onChange={() => toggle(file.id)}
                      className="h-4 w-4 shrink-0 accent-white"
                    />

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{file.filename}</span>

                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-white/40">
                        <span className={presentation.tone}>{presentation.label}</span>
                        <span>{formatBytes(file.sizeBytes)}</span>
                        {/* Stated on the row itself, not buried in a tooltip. */}
                        {note && <span className="text-white/35">· {note}</span>}
                        {isImage(file.mimeType) && (
                          <span className="text-white/35">· รูปภาพ</span>
                        )}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/10 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void upload(e.target.files);
            }}
          />

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="min-h-11 shrink-0 rounded-lg border border-white/20 px-4 text-sm hover:bg-white/5 disabled:opacity-40"
          >
            {uploading ? "กำลังอัปโหลด..." : "อัปโหลดไฟล์ใหม่"}
          </button>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => {
              onAttach(selected);
              onClose();
            }}
            disabled={selected.length === 0}
            className="min-h-11 shrink-0 rounded-lg bg-white px-5 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            แนบ {selected.length > 0 ? `(${selected.length})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
