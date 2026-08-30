"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type StoredFile = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractStatus: string;
  extractReason: string | null;
  extractedChars: number | null;
  extractTruncated: boolean;
  createdAt: string;
};

type FileDetail = StoredFile & {
  preview: string | null;
  previewTruncated: boolean;
  units: Array<{ kind: string; label: string; chars: number }> | null;
  metadata: Record<string, string | number> | null;
};

/**
 * Every state a user can see, phrased so the difference between "nothing to read" and
 * "we could not read it" is never ambiguous.
 */
const STATUS_TEXT: Record<string, { label: string; tone: string; hint: string }> = {
  PENDING: { label: "รอประมวลผล", tone: "text-white/40", hint: "กำลังรอคิวอ่านเนื้อหา" },
  PROCESSING: { label: "กำลังอ่าน", tone: "text-sky-300", hint: "กำลังอ่านเนื้อหาไฟล์" },
  EXTRACTED: { label: "อ่านแล้ว", tone: "text-emerald-300", hint: "อ่านเนื้อหาได้ครบถ้วน" },
  PARTIAL: { label: "อ่านบางส่วน", tone: "text-amber-300", hint: "อ่านได้บางส่วนเท่านั้น" },
  UNSUPPORTED: { label: "ไม่รองรับ", tone: "text-white/40", hint: "เก็บและดาวน์โหลดได้ แต่อ่านเนื้อหาไม่ได้" },
  FAILED: { label: "อ่านไม่สำเร็จ", tone: "text-red-300", hint: "ไม่สามารถอ่านเนื้อหาไฟล์นี้ได้" },
  SKIPPED: { label: "ไม่ได้อ่าน", tone: "text-white/40", hint: "อัปโหลดก่อนระบบอ่านไฟล์จะเปิดใช้งาน" },
};

type Quota = { usedBytes: number; limitBytes: number };

type PendingUpload = {
  name: string;
  status: "uploading" | "done" | "error";
  message?: string;
};

const REJECTION_TEXT: Record<string, string> = {
  too_large: "ไฟล์ใหญ่เกินกำหนด",
  too_many: "ไฟล์มากเกินไปต่อการอัปโหลดหนึ่งครั้ง",
  quota_exceeded: "พื้นที่จัดเก็บเต็ม",
  mime_mismatch: "ชนิดไฟล์ไม่ตรงกับนามสกุล",
  empty: "ไฟล์ว่าง",
  rate_limited: "อัปโหลดถี่เกินไป กรุณารอสักครู่",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Images are stored and previewed, but the deployed model cannot read them. */
function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export default function FileWorkspace() {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/files", { cache: "no-store" });
      if (!res.ok) throw new Error(`Unable to load files (${res.status})`);
      const data = await res.json();
      setFiles(data.files ?? []);
      setQuota(data.quota ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load files");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Extraction is asynchronous, so the list refreshes while anything is still in
  // flight. The interval stops as soon as nothing is pending — it is not a permanent
  // background poll.
  useEffect(() => {
    const inFlight = files.some(
      (f) => f.extractStatus === "PENDING" || f.extractStatus === "PROCESSING"
    );

    if (!inFlight) return;

    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [files, refresh]);

  const upload = useCallback(
    async (selected: FileList | File[]) => {
      const list = Array.from(selected);
      if (list.length === 0) return;

      setPending(list.map((f) => ({ name: f.name, status: "uploading" as const })));

      const form = new FormData();
      for (const f of list) form.append("files", f);

      try {
        const res = await fetch("/api/files", { method: "POST", body: form });
        const data = await res.json().catch(() => null);

        if (res.status === 429) {
          setPending(list.map((f) => ({
            name: f.name,
            status: "error" as const,
            message: REJECTION_TEXT.rate_limited,
          })));
          return;
        }

        // The API reports per-file outcomes, so the UI must too: a batch where two of
        // five files were rejected is neither a success nor a failure.
        const results: Array<{ ok: boolean; filename: string; reason?: string }> =
          data?.results ?? [];

        setPending(
          list.map((f) => {
            const r = results.find((x) => x.filename === f.name || x.filename === f.name.split(/[\\/]/).pop());
            if (!r) return { name: f.name, status: "error" as const, message: "ไม่ทราบผลลัพธ์" };
            return r.ok
              ? { name: f.name, status: "done" as const }
              : { name: f.name, status: "error" as const, message: REJECTION_TEXT[r.reason ?? ""] ?? "ถูกปฏิเสธ" };
          })
        );

        await refresh();
      } catch {
        setPending(list.map((f) => ({ name: f.name, status: "error" as const, message: "อัปโหลดล้มเหลว" })));
      }
    },
    [refresh]
  );

  async function openDetail(id: string) {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/files/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error("not found");
      setDetail((await res.json()).file);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/files/${id}`, { method: "DELETE" });
    if (res.ok) await refresh();
  }

  const quotaPct = quota ? Math.min(100, Math.round((quota.usedBytes / quota.limitBytes) * 100)) : 0;

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-zinc-950 text-white">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4 sm:h-16 sm:px-6">
        <Link
          href="/chat"
          aria-label="Back to chat"
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/5 hover:text-white"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <span className="font-medium">Files</span>
        </div>
        {quota && (
          <span className="shrink-0 text-xs text-white/40">
            {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto max-w-3xl">
          {/*
            Stated once, prominently, rather than per-file: the deployed model is
            text-only. Users who upload an image and ask about it would otherwise
            reasonably assume the AI had seen it.
          */}
          <p className="mb-5 rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-200/90">
            ไฟล์ทั้งหมดถูกจัดเก็บและดาวน์โหลดได้
            <span className="mt-1 block text-amber-200/70">
              ขณะนี้ INNOVERA AI ยังไม่สามารถอ่านเนื้อหาไฟล์หรือดูรูปภาพได้ — การเชื่อมไฟล์เข้ากับ AI จะมาในเวอร์ชันถัดไป
            </span>
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(e.dataTransfer.files);
            }}
            className={`rounded-2xl border-2 border-dashed p-6 text-center transition-colors sm:p-10 ${
              dragging ? "border-white/40 bg-white/5" : "border-white/15"
            }`}
          >
            <p className="text-sm text-white/60">ลากไฟล์มาวางที่นี่</p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-3 min-h-11 rounded-lg bg-white px-5 font-medium text-black"
            >
              เลือกไฟล์
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {pending.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {pending.map((p, i) => (
                <li
                  key={`${p.name}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span
                    className={`shrink-0 text-xs ${
                      p.status === "done"
                        ? "text-emerald-300"
                        : p.status === "error"
                          ? "text-red-300"
                          : "text-white/40"
                    }`}
                  >
                    {p.status === "uploading" ? "กำลังอัปโหลด..." : p.status === "done" ? "สำเร็จ" : p.message}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {quota && (
            <div className="mt-6">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-white/50" style={{ width: `${quotaPct}%` }} />
              </div>
            </div>
          )}

          <h2 className="mt-8 mb-3 text-xs uppercase tracking-wider text-white/30">
            ไฟล์ของคุณ
          </h2>

          {error && <p className="text-sm text-red-300">{error}</p>}

          {loading ? (
            <p className="text-sm text-white/30">กำลังโหลด...</p>
          ) : files.length === 0 ? (
            <p className="text-sm text-white/30">ยังไม่มีไฟล์</p>
          ) : (
            <ul className="space-y-2">
              {files.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center gap-3 rounded-xl border border-white/10 px-3 py-2.5"
                >
                  <button
                    type="button"
                    onClick={() => void openDetail(f.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-sm">{f.filename}</p>
                    <p className="mt-0.5 text-xs text-white/35">
                      {formatBytes(f.sizeBytes)} · {f.mimeType}
                      <span className={`ml-2 ${STATUS_TEXT[f.extractStatus]?.tone ?? "text-white/40"}`}>
                        {STATUS_TEXT[f.extractStatus]?.label ?? f.extractStatus}
                      </span>
                    </p>
                  </button>

                  <a
                    href={`/api/files/${f.id}/content`}
                    className="flex h-11 shrink-0 items-center rounded-lg border border-white/15 px-3 text-sm hover:bg-white/5"
                  >
                    ดาวน์โหลด
                  </a>

                  <button
                    type="button"
                    onClick={() => void remove(f.id)}
                    aria-label={`ลบ ${f.filename}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/50 hover:bg-white/5 hover:text-white"
                  >
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Preview panel. Rendered as an overlay so the mobile layout stays single-pane. */}
      {(detail || detailLoading) && (
        <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4 sm:h-16 sm:px-6">
            <button
              type="button"
              onClick={() => setDetail(null)}
              aria-label="Close preview"
              className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/5"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
              </svg>
            </button>
            <p className="min-w-0 flex-1 truncate text-sm">{detail?.filename ?? "..."}</p>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {detailLoading || !detail ? (
              <p className="text-sm text-white/40">กำลังโหลด...</p>
            ) : (
              <div className="mx-auto max-w-3xl">
                <p className="text-xs text-white/35">
                  {formatBytes(detail.sizeBytes)} · {detail.mimeType}
                </p>

                <p className={`mt-2 text-sm ${STATUS_TEXT[detail.extractStatus]?.tone ?? "text-white/50"}`}>
                  {STATUS_TEXT[detail.extractStatus]?.label ?? detail.extractStatus}
                  <span className="ml-2 text-white/40">
                    {STATUS_TEXT[detail.extractStatus]?.hint}
                  </span>
                </p>

                {/* The parser's own explanation, when it has one. This is what turns a
                    blank panel into an answer — a scanned PDF says why it is empty. */}
                {detail.extractReason && (
                  <p className="mt-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/60">
                    {detail.extractReason}
                  </p>
                )}

                {detail.units && detail.units.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-1.5 text-xs uppercase tracking-wider text-white/30">
                      {detail.units[0].kind === "sheet" ? "ชีต" : "สไลด์"}
                    </p>
                    <ul className="flex flex-wrap gap-1.5">
                      {detail.units.map((u) => (
                        <li
                          key={u.label}
                          className="rounded-md border border-white/10 px-2 py-1 text-xs text-white/60"
                        >
                          {u.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Images are served through the authenticated content endpoint, never
                    from a public path. HTML and SVG are sent as text/plain with
                    Content-Disposition: attachment, so neither can render as active
                    markup here. */}
                {isImage(detail.mimeType) && (
                  <div className="mt-5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/files/${detail.id}/content`}
                      alt={detail.filename}
                      className="max-h-[60vh] w-auto max-w-full rounded-xl border border-white/10"
                    />
                  </div>
                )}

                {detail.preview !== null && detail.preview.length > 0 && (
                  <div className="mt-5">
                    <p className="mb-1.5 text-xs uppercase tracking-wider text-white/30">
                      เนื้อหา
                      {detail.extractedChars !== null && (
                        <span className="ml-2 normal-case tracking-normal text-white/25">
                          {detail.extractedChars.toLocaleString()} ตัวอักษร
                          {detail.extractTruncated && " (ตัดทอน)"}
                        </span>
                      )}
                    </p>

                    {/*
                      Rendered as a text child, so React escapes it. Never
                      dangerouslySetInnerHTML: this string came from a user's file and
                      may contain markup by design.
                    */}
                    <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-white/5 p-3 text-xs leading-6 text-white/80">
                      {detail.preview}
                    </pre>

                    {detail.previewTruncated && (
                      <p className="mt-1.5 text-xs text-white/35">
                        แสดงเฉพาะส่วนต้นของเนื้อหา — ดาวน์โหลดไฟล์เพื่อดูทั้งหมด
                      </p>
                    )}
                  </div>
                )}

                <a
                  href={`/api/files/${detail.id}/content`}
                  className="mt-6 inline-flex min-h-11 items-center rounded-lg border border-white/15 px-4 text-sm hover:bg-white/5"
                >
                  ดาวน์โหลดไฟล์ต้นฉบับ
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
