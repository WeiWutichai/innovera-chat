import { LIMITS, applyCharLimit } from "@/lib/extraction/limits";
import type { ExtractionResult, Parser } from "@/lib/extraction/types";
import { failed } from "@/lib/extraction/types";
import { extensionOf } from "@/lib/files/validate";

/**
 * Text, code, CSV, JSON, YAML, XML and logs.
 *
 * XML AND YAML ARE NOT SEMANTICALLY PARSED, AND THAT IS THE SECURITY DESIGN.
 *
 * XXE and billion-laughs are attacks on an entity-expanding parser. This extractor
 * never expands an entity because it never interprets the document at all — it decodes
 * bytes to text and applies a character ceiling. There is no resolver to disable and no
 * external entity to fetch, so the vulnerability class is absent by construction rather
 * than suppressed by configuration.
 *
 * The same reasoning removes the need for a YAML dependency: for extraction, the value
 * of a YAML file IS its text.
 */

/** Rejects content that is not plausibly text before spending a decode on it. */
function decodeUtf8(buffer: Buffer): { text: string; replacementRatio: number } {
  const text = buffer.toString("utf8");

  // U+FFFD is what Buffer#toString emits for invalid sequences. A high proportion means
  // this was not UTF-8 — most likely a legacy encoding or binary.
  let replacements = 0;
  for (const ch of text) if (ch === "�") replacements++;

  return { text, replacementRatio: text.length === 0 ? 0 : replacements / text.length };
}

function parseCsv(text: string): { text: string; rows: number; truncatedRows: boolean } {
  const lines = text.split(/\r?\n/);
  const kept = lines.slice(0, LIMITS.csv.maxRows);

  return {
    text: kept.join("\n"),
    rows: lines.length,
    truncatedRows: lines.length > LIMITS.csv.maxRows,
  };
}

export const textParser: Parser = async ({ buffer, filename }) => {
  if (buffer.length > LIMITS.maxTextBytes) {
    return failed("file is too large to decode as text");
  }

  const { text: decoded, replacementRatio } = decodeUtf8(buffer);

  if (replacementRatio > 0.1) {
    // Not a failure of our code — the file simply is not UTF-8 text. Reported as such
    // rather than returning mojibake the user would have to diagnose themselves.
    return failed("file is not valid UTF-8 text");
  }

  const ext = extensionOf(filename);
  const metadata: Record<string, string | number> = { bytes: buffer.length };
  let working = decoded;
  let structurallyIncomplete = false;

  if (ext === "csv") {
    const csv = parseCsv(decoded);
    working = csv.text;
    metadata.rows = csv.rows;
    if (csv.truncatedRows) {
      metadata.rowsRetained = LIMITS.csv.maxRows;
      structurallyIncomplete = true;
    }
  }

  if (ext === "json") {
    // Validated, never re-serialised: the user's formatting is part of the content.
    try {
      JSON.parse(decoded);
      metadata.jsonValid = "true";
    } catch {
      metadata.jsonValid = "false";
      structurallyIncomplete = true;
    }
  }

  const limited = applyCharLimit(working);

  const result: ExtractionResult = {
    status: limited.truncated || structurallyIncomplete ? "partial" : "extracted",
    text: limited.text,
    chars: limited.chars,
    truncated: limited.truncated,
    metadata,
  };

  if (metadata.jsonValid === "false") result.reason = "file is not valid JSON; stored as plain text";
  else if (structurallyIncomplete) result.reason = `only the first ${LIMITS.csv.maxRows} rows were retained`;
  else if (limited.truncated) result.reason = "content exceeded the extraction character limit";

  return result;
};
