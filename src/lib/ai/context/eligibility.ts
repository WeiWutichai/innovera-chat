/**
 * Which attached files may contribute TEXT to the model prompt.
 *
 * The rule is an ALLOWLIST of two states. Everything else is announced to the model by
 * status but contributes no content, because the alternative — silently omitting a file
 * the user can see attached — invites the model to invent what it must have said.
 *
 *   EXTRACTED   -> eligible, content is complete within the extractor's limits
 *   PARTIAL     -> eligible, and MUST be labelled as incomplete wherever it appears
 *   UNSUPPORTED -> no content (an archive, an unknown binary, an image)
 *   FAILED      -> no content (parsing was attempted and did not succeed)
 *   PENDING     -> no content (not read yet)
 *   PROCESSING  -> no content (being read right now)
 *   SKIPPED     -> no content (uploaded before extraction existed)
 *
 * Nothing here ever decodes or forwards file BYTES. Only text the extractor already
 * produced and stored can travel, and images produce none by construction.
 */

export type EligibilityVerdict =
  | { eligible: true; complete: boolean }
  | { eligible: false; reason: string };

/** Statuses whose extracted text may enter the prompt. */
const ELIGIBLE = new Set(["EXTRACTED", "PARTIAL"]);

/**
 * Why a file contributes nothing, phrased for the model.
 *
 * These strings are shown to the model verbatim, so each one states what is true and
 * what the model must therefore NOT do. "Content unavailable" alone reads as an
 * invitation to guess.
 */
const UNAVAILABLE: Record<string, string> = {
  UNSUPPORTED:
    "content unavailable — this file type cannot be read as text (it is stored and downloadable, but never parsed)",
  FAILED: "content unavailable — reading this file did not succeed",
  PENDING: "content unavailable — this file has not been read yet",
  PROCESSING: "content unavailable — this file is still being read",
  SKIPPED:
    "content unavailable — this file was uploaded before file reading existed and has not been read",
};

const IMAGE_PREFIX = "image/";

export function classify(file: {
  mimeType: string;
  extractStatus: string;
  extractedText: string | null;
  extractTruncated: boolean;
}): EligibilityVerdict {
  // Checked before the status allowlist. The current model is TEXT-ONLY: no image bytes
  // are ever sent, no vision model is called, and no OCR is performed. An image is
  // therefore always "no content", and saying so explicitly stops the model presenting
  // a filename-based guess as if it had looked at the picture.
  if (file.mimeType.startsWith(IMAGE_PREFIX)) {
    return {
      eligible: false,
      reason:
        "content unavailable — this is an image and the assistant is text-only; it cannot see images and must not describe or guess this image's contents",
    };
  }

  if (!ELIGIBLE.has(file.extractStatus)) {
    return {
      eligible: false,
      reason: UNAVAILABLE[file.extractStatus] ?? "content unavailable",
    };
  }

  // An eligible status with no stored text is still no content. Trusting the status
  // alone would emit an empty CONTENT block that reads as "this file is empty".
  if (file.extractedText === null || file.extractedText.length === 0) {
    return {
      eligible: false,
      reason: "content unavailable — no readable text was recovered from this file",
    };
  }

  return {
    eligible: true,
    complete: file.extractStatus === "EXTRACTED" && !file.extractTruncated,
  };
}
