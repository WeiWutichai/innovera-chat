/**
 * Upload validation.
 *
 * The uploaded filename and the client-supplied Content-Type are both attacker-
 * controlled and are never trusted as evidence of what a file is. The bytes decide.
 *
 * M1 does not parse any file. Sniffing exists to (a) choose a safe Content-Type to
 * serve back and (b) detect a declared type that disagrees with the content — not to
 * enable extraction, which is M2.
 */

export type SniffResult = {
  /** Content-Type safe to serve. Never taken from the client. */
  mimeType: string;
  /** True when bytes were recognised; false means "stored, not understood". */
  recognised: boolean;
};

type Signature = {
  mime: string;
  offset: number;
  bytes: number[];
  /** Extensions that legitimately carry these magic bytes. */
  extensions: string[];
};

/**
 * Magic-byte signatures. Ordered longest-first where prefixes overlap.
 *
 * ZIP-based office formats (docx/xlsx/pptx) all begin PK\x03\x04 and are indistinguish-
 * able without reading the central directory, which is archive expansion — explicitly
 * out of scope for M1. They are therefore sniffed as ZIP and reconciled against the
 * extension below.
 */
const SIGNATURES: Signature[] = [
  { mime: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], extensions: ["pdf"] },
  { mime: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], extensions: ["png"] },
  { mime: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff], extensions: ["jpg", "jpeg"] },
  { mime: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], extensions: ["gif"] },
  { mime: "application/zip", offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], extensions: ["zip", "docx", "xlsx", "pptx"] },
  { mime: "application/zip", offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06], extensions: ["zip", "docx", "xlsx", "pptx"] },
  { mime: "application/gzip", offset: 0, bytes: [0x1f, 0x8b], extensions: ["gz", "tgz"] },
  { mime: "application/x-7z-compressed", offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], extensions: ["7z"] },
  { mime: "application/x-tar", offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72], extensions: ["tar"] },
];

/** RIFF....WEBP — the format tag sits at offset 8, so it needs its own check. */
function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  );
}

/** Extensions treated as plain text, served as text/plain. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv", "json", "xml", "yaml", "yml", "log",
  "js", "jsx", "ts", "tsx", "py", "java", "cs", "go", "rs", "php", "rb",
  "sh", "sql", "html", "css", "vue", "kt", "swift", "c", "h", "cpp", "hpp",
  "toml", "ini", "cfg", "conf", "env-example", "gitignore", "dockerfile",
]);

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Heuristic text detection for files with no magic bytes.
 *
 * A NUL byte in the first 8 KB means binary; otherwise a high proportion of control
 * characters does. This is deliberately conservative: misclassifying binary as text
 * only affects the Content-Type we serve, and Content-Disposition: attachment plus
 * nosniff means the browser will not execute it either way.
 */
function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  if (sample.length === 0) return true;

  let suspicious = 0;

  for (const byte of sample) {
    if (byte === 0) return false;
    // Allow tab, LF, CR; count other C0 controls and DEL as suspicious.
    if ((byte < 0x09 || (byte > 0x0d && byte < 0x20)) || byte === 0x7f) suspicious++;
  }

  return suspicious / sample.length < 0.05;
}

export function sniff(buf: Buffer, filename: string): SniffResult {
  for (const sig of SIGNATURES) {
    const end = sig.offset + sig.bytes.length;
    if (buf.length < end) continue;
    if (sig.bytes.every((b, i) => buf[sig.offset + i] === b)) {
      return { mimeType: sig.mime, recognised: true };
    }
  }

  if (isWebp(buf)) return { mimeType: "image/webp", recognised: true };

  if (looksLikeText(buf)) {
    // Always served as text/plain regardless of extension: serving .html or .svg as
    // their real type from our own origin would be stored XSS. `recognised` records
    // whether the extension is a known text/code type, which the consistency check uses.
    return {
      mimeType: "text/plain",
      recognised: TEXT_EXTENSIONS.has(extensionOf(filename)),
    };
  }

  return { mimeType: "application/octet-stream", recognised: false };
}

export type ConsistencyVerdict =
  | { ok: true }
  | { ok: false; reason: "mime_mismatch" };

/**
 * Extension/content agreement.
 *
 * The policy is narrow on purpose: it rejects only cases where the bytes are RECOGNISED
 * and the extension claims a different recognised type — a .pdf that is really a PNG.
 * Unrecognised bytes are allowed through and stored as octet-stream, because "we do not
 * know what this is" is a legitimate M1 outcome and must not become a rejection.
 */
export function checkConsistency(sniffed: SniffResult, filename: string): ConsistencyVerdict {
  if (!sniffed.recognised) return { ok: true };

  const ext = extensionOf(filename);
  if (!ext) return { ok: true };

  const claims = SIGNATURES.filter((s) => s.extensions.includes(ext));

  // The extension is not one any signature claims (e.g. .dat) — nothing to contradict.
  if (claims.length === 0 && !TEXT_EXTENSIONS.has(ext)) return { ok: true };

  // A text extension carrying recognised binary magic bytes is a mismatch.
  if (TEXT_EXTENSIONS.has(ext)) {
    return sniffed.mimeType.startsWith("text/") ? { ok: true } : { ok: false, reason: "mime_mismatch" };
  }

  return claims.some((c) => c.mime === sniffed.mimeType)
    ? { ok: true }
    : { ok: false, reason: "mime_mismatch" };
}

/**
 * Filename sanitisation for DISPLAY and Content-Disposition only.
 *
 * This is never used to build a filesystem path — storage keys are server-generated —
 * so its job is narrower than it looks: strip directory components, control characters
 * and quotes so the value cannot break out of a header or mislead a user about the
 * file's type.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";

  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["\\]/g, "")
    .trim();

  // "..", "." and empty are all meaningless as display names.
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "unnamed";

  return cleaned.slice(0, 255);
}

/**
 * RFC 5987 Content-Disposition value.
 *
 * Always `attachment`. Never `inline`: an inline HTML or SVG upload served from our own
 * origin would execute as same-origin script, which is stored XSS. Both a plain filename
 * (ASCII fallback) and filename* (UTF-8) are emitted so non-ASCII names survive.
 */
export function contentDisposition(filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
