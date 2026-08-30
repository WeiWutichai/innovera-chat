import { LIMITS } from "@/lib/extraction/limits";
import type { ExtractionResult, Parser } from "@/lib/extraction/types";
import { failed, unsupported } from "@/lib/extraction/types";
import { extensionOf } from "@/lib/files/validate";
import { textParser } from "@/lib/extraction/parsers/text";
import { ooxmlParser } from "@/lib/extraction/parsers/ooxml";
import { pdfParser } from "@/lib/extraction/parsers/pdf";
import { imageParser } from "@/lib/extraction/parsers/image";

/**
 * Chooses a parser, or declines explicitly.
 *
 * An ALLOWLIST: anything not named here is `unsupported`, which is a first-class outcome
 * rather than a gap. Defaulting to "try the text parser" would mean feeding arbitrary
 * binaries through a decoder and reporting mojibake as content.
 */

/** OOXML containers all sniff as application/zip — the extension disambiguates intent. */
const OOXML_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);

/** Stored and downloadable, never opened. */
const ARCHIVE_MIMES = new Set([
  "application/zip",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-tar",
]);

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type Selection = { parser: Parser; kind: string } | { parser: null; result: ExtractionResult };

export function selectParser(mimeType: string, filename: string): Selection {
  const ext = extensionOf(filename);

  if (mimeType === "application/pdf") return { parser: pdfParser, kind: "pdf" };

  if (IMAGE_MIMES.has(mimeType)) return { parser: imageParser, kind: "image" };

  // Checked BEFORE the archive rule: a .docx is a zip by content, but it is a document
  // by intent, and expanding it is reading the format rather than opening an archive.
  if (ARCHIVE_MIMES.has(mimeType) && OOXML_EXTENSIONS.has(ext)) {
    return { parser: ooxmlParser, kind: `ooxml:${ext}` };
  }

  if (ARCHIVE_MIMES.has(mimeType)) {
    return {
      parser: null,
      result: unsupported(
        "archives are stored and downloadable, but their contents are never expanded or read",
        { archive: ext || "unknown" }
      ),
    };
  }

  if (mimeType.startsWith("text/")) return { parser: textParser, kind: "text" };

  return {
    parser: null,
    result: unsupported("this file type is stored and downloadable, but its content cannot be read", {
      mimeType,
    }),
  };
}

/**
 * Runs a parser under a wall-clock budget.
 *
 * ==================== WHAT THIS TIMEOUT IS, AND WHAT IT IS NOT ====================
 * This is NOT a hard resource boundary, and must not be described as one.
 *
 * `Promise.race` stops WAITING. It cannot abort work already running. A parser that
 * blocks the event loop synchronously keeps consuming CPU after the timeout has
 * logically won, and it will keep consuming it until it finishes on its own. There is no
 * mechanism in a single Node process to kill it. Only a real isolation boundary — a
 * worker thread, a child process, a container — could do that, and none is introduced
 * here.
 *
 * What actually bounds the work is therefore NOT this timer. It is the STRUCTURAL LIMITS
 * applied before and during parsing, which is why those limits are cheap and are checked
 * before any expensive processing:
 *
 *   - ZIP entries are rejected on the entry count, per-entry size, total inflated size
 *     and compression ratio recorded in the central directory, BEFORE inflating.
 *   - PDF page count is bounded before page text is pulled.
 *   - Sheets, rows, cells, slides and paragraphs are counted as they stream, and the
 *     parser stops at the ceiling rather than reading to the end and truncating.
 *   - The text decoder refuses to scan past `maxTextBytes`.
 *
 * The timer is an outer backstop for the case those limits fail to anticipate, and it
 * bounds how long the QUEUE waits — not how long the CPU burns.
 *
 * Two consequences follow, and both are relied upon:
 *
 *   1. A parser that REJECTS after the race has settled does not become an unhandled
 *      rejection, because `Promise.race` subscribes to both promises and keeps that
 *      subscription after settling. This is a property of the race, not something added
 *      on top — which is exactly why it is pinned by a test: a future rewrite that stops
 *      passing the parser promise to `race` would reintroduce an unhandled rejection,
 *      and under `--unhandled-rejections=strict` that terminates the process.
 *   2. A late completion cannot corrupt state, because the parser never writes anything.
 *      Only the queue writes, once, after this function resolves — and that write is
 *      fenced on the claim's attempt number. See queue.ts.
 * =================================================================================
 */
export async function runExtraction(input: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<ExtractionResult> {
  const selection = selectParser(input.mimeType, input.filename);

  if (!selection.parser) return selection.result;

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const running = selection.parser(input);

    const timeout = new Promise<ExtractionResult>((resolve) => {
      timer = setTimeout(
        () => resolve(failed(`extraction exceeded the ${LIMITS.timeoutMs / 1000}s time limit`)),
        LIMITS.timeoutMs
      );
    });

    return await Promise.race([running, timeout]);
  } catch {
    // A parser that throws is a bug or a hostile input; either way the user gets a
    // classified failure, never an internal message.
    return failed("extraction failed unexpectedly");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
