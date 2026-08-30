/**
 * Structural ceilings for every parser.
 *
 * These are hard constants rather than environment configuration on purpose. They bound
 * the work a single malicious or pathological file can cause, and an operator has no
 * legitimate reason to raise them at runtime — a file that needs more than this is a
 * corpus, not an attachment, and belongs to a later milestone.
 */
export const LIMITS = {
  /** Wall-clock budget for one parse. */
  timeoutMs: 30_000,

  /** Extracted characters retained per file. 20x the whole chat context budget. */
  maxChars: 400_000,

  /** Bytes of a file a text parser will look at before giving up on decoding. */
  maxTextBytes: 32 * 1024 * 1024,

  pdf: { maxPages: 500 },
  xlsx: { maxSheets: 50, maxRowsPerSheet: 5_000, maxCellsPerSheet: 50_000, maxCellChars: 4_000 },
  pptx: { maxSlides: 500 },
  docx: { maxParagraphs: 100_000 },

  /**
   * Bounds ZIP expansion for OOXML. A 50 MB docx that inflates to 5 GB is a zip bomb;
   * capping the ratio and the absolute total stops it before memory is exhausted.
   */
  zip: {
    maxEntries: 2_000,
    maxEntryBytes: 64 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
    maxCompressionRatio: 200,
  },

  csv: { maxRows: 5_000 },
} as const;

/** Truncates to the character ceiling, reporting the pre-truncation length. */
export function applyCharLimit(text: string): { text: string; chars: number; truncated: boolean } {
  const chars = text.length;

  if (chars <= LIMITS.maxChars) {
    return { text, chars, truncated: false };
  }

  return { text: text.slice(0, LIMITS.maxChars), chars, truncated: true };
}
