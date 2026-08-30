import { LIMITS, applyCharLimit } from "@/lib/extraction/limits";
import type { Parser } from "@/lib/extraction/types";
import { failed } from "@/lib/extraction/types";

/**
 * PDF — TEXT LAYER ONLY.
 *
 * A scanned document is a sequence of images with no text layer. This parser will find
 * nothing in one, and that must be reported as a distinct, explained outcome rather
 * than an empty success: a user who uploads a scan and sees a blank preview would
 * reasonably conclude the feature is broken.
 *
 * There is no OCR here, and no image is ever decoded or sent anywhere.
 */
export const pdfParser: Parser = async ({ buffer }) => {
  let extractText: typeof import("unpdf").extractText;
  let getDocumentProxy: typeof import("unpdf").getDocumentProxy;

  try {
    // Imported lazily so the ~2 MB PDF engine is not pulled into memory for the many
    // uploads that are plain text.
    ({ extractText, getDocumentProxy } = await import("unpdf"));
  } catch {
    return failed("PDF support is unavailable in this deployment");
  }

  let text: string;
  let totalPages: number;

  try {
    const doc = await getDocumentProxy(new Uint8Array(buffer));

    totalPages = doc.numPages;

    if (totalPages > LIMITS.pdf.maxPages) {
      return {
        status: "partial",
        reason: `document has ${totalPages} pages; only the first ${LIMITS.pdf.maxPages} were considered`,
        text: "",
        chars: 0,
        truncated: true,
        metadata: { pages: totalPages },
      };
    }

    const result = await extractText(doc, { mergePages: true });
    text = String(result.text ?? "");
  } catch {
    // Deliberately not surfacing the library's message: it can name internal paths and
    // is not meaningful to a user.
    return failed("file is not a readable PDF");
  }

  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return {
      status: "unsupported",
      reason:
        "this PDF has no text layer — it is most likely a scan. Text extraction is not available for scanned documents.",
      text: "",
      chars: 0,
      truncated: false,
      metadata: { pages: totalPages, textLayer: "none" },
    };
  }

  const limited = applyCharLimit(trimmed);

  return {
    status: limited.truncated ? "partial" : "extracted",
    reason: limited.truncated ? "content exceeded the extraction character limit" : undefined,
    text: limited.text,
    chars: limited.chars,
    truncated: limited.truncated,
    metadata: { pages: totalPages, textLayer: "present" },
  };
};
