/** Terminal and in-flight states an extraction can be in. */
export type ExtractionStatus =
  | "extracted"    // full content recovered within limits
  | "partial"      // real content recovered, but truncated or incomplete
  | "unsupported"  // deliberately not parsed (archive, unknown binary, image)
  | "failed";      // parsing was attempted and did not succeed

/** A page, sheet or slide. */
export type ExtractionUnit = {
  kind: "page" | "sheet" | "slide";
  label: string;
  chars: number;
};

/**
 * The one shape every parser returns.
 *
 * `status` is deliberately separate from `text`: an empty string with status
 * "extracted" ("this file genuinely contains no text") means something different from
 * an empty string with status "failed" ("we could not read it"), and the UI must be
 * able to tell a user which happened rather than showing a blank panel either way.
 */
export type ExtractionResult = {
  status: ExtractionStatus;
  /** Short, classified, user-safe. Never a stack trace or a library message. */
  reason?: string;
  text: string;
  /** Characters BEFORE truncation, so accounting stays honest. */
  chars: number;
  truncated: boolean;
  units?: ExtractionUnit[];
  metadata: Record<string, string | number>;
};

export type Parser = (input: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}) => Promise<ExtractionResult>;

export function unsupported(reason: string, metadata: Record<string, string | number> = {}): ExtractionResult {
  return { status: "unsupported", reason, text: "", chars: 0, truncated: false, metadata };
}

export function failed(reason: string, metadata: Record<string, string | number> = {}): ExtractionResult {
  return { status: "failed", reason, text: "", chars: 0, truncated: false, metadata };
}
