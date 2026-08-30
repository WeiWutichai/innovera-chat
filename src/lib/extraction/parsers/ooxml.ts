import { unzipSync, type Unzipped } from "fflate";
import { LIMITS, applyCharLimit } from "@/lib/extraction/limits";
import type { ExtractionResult, ExtractionUnit, Parser } from "@/lib/extraction/types";
import { failed } from "@/lib/extraction/types";

/**
 * DOCX, XLSX and PPTX.
 *
 * All three are ZIP containers of XML, so one unzip plus one bounded text scan handles
 * every one of them. That is why this file exists instead of three dependencies:
 * mammoth pulls ten transitive packages, and the `xlsx` package is deprecated on npm
 * with outstanding advisories. fflate is zero-dependency, has no install script and
 * ships no native binary, and doing the XML scan here means the ceilings below are ours
 * rather than whatever a library happens to enforce.
 *
 * NOTE ON "ARCHIVES ARE NEVER EXPANDED": that rule is about user-supplied archives —
 * .zip/.tar/.7z are stored and never opened. An OOXML container is expanded because
 * the container IS the document format, and only under the bounds in LIMITS.zip.
 */

/** Extracts text from XML without ever interpreting it as XML. */
function xmlText(xml: string, separator = " "): string {
  // Entity expansion is impossible here because entities are never resolved — the five
  // predefined ones are replaced literally and everything else is left as written.
  // There is no DTD processing, so XXE and billion-laughs have nothing to act on.
  const withoutTags = xml
    .replace(/<[^>]*>/g, separator)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

  return withoutTags.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * Unzips within bounds.
 *
 * A malicious OOXML file is a zip bomb with a document extension, so entry count, per-
 * entry size, total inflated size and compression ratio are all capped. Returning null
 * rather than throwing keeps the caller's error handling in one place.
 */
function boundedUnzip(buffer: Buffer): { files: Unzipped; totalBytes: number } | null {
  let files: Unzipped;

  // ---------------------------------------------------------------------------
  // PASS 1 — cheap, BEFORE inflation.
  //
  // fflate's `filter` runs per entry with the sizes declared in the zip's central
  // directory, and an entry is only inflated if the filter returns true. Checking here
  // is what stops a bomb from being expanded into the heap at all: the previous version
  // of this function inflated the whole archive with unzipSync and only then measured
  // it, which meant a 50 MB file declaring 5 GB of content was already resident in
  // memory by the time it was rejected.
  //
  // Throwing out of the filter aborts the whole archive rather than merely skipping the
  // offending entry — a partial OOXML part set is not a document.
  // ---------------------------------------------------------------------------
  let entries = 0;
  let declaredTotal = 0;

  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter: (file) => {
        if (++entries > LIMITS.zip.maxEntries) throw new Error("zip bounds exceeded");
        if (file.originalSize > LIMITS.zip.maxEntryBytes) throw new Error("zip bounds exceeded");

        declaredTotal += file.originalSize;
        if (declaredTotal > LIMITS.zip.maxTotalBytes) throw new Error("zip bounds exceeded");

        if (
          buffer.length > 0 &&
          declaredTotal / buffer.length > LIMITS.zip.maxCompressionRatio
        ) {
          throw new Error("zip bounds exceeded");
        }

        return true;
      },
    });
  } catch {
    return null;
  }

  // ---------------------------------------------------------------------------
  // PASS 2 — authoritative, AFTER inflation.
  //
  // The sizes in pass 1 come from the archive itself and are therefore attacker
  // controlled: a hostile zip can declare 1 KB and inflate to 1 GB. Pass 1 is an
  // optimisation that rejects the honest bomb cheaply; THIS is the check that is
  // actually trusted, and it is measured on the real inflated bytes.
  // ---------------------------------------------------------------------------
  const names = Object.keys(files);
  if (names.length > LIMITS.zip.maxEntries) return null;

  let totalBytes = 0;

  for (const name of names) {
    const size = files[name].length;

    if (size > LIMITS.zip.maxEntryBytes) return null;

    totalBytes += size;
    if (totalBytes > LIMITS.zip.maxTotalBytes) return null;
  }

  if (buffer.length > 0 && totalBytes / buffer.length > LIMITS.zip.maxCompressionRatio) {
    return null;
  }

  return { files, totalBytes };
}

const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

/** Entries matching a prefix, ordered by their embedded number (slide2 before slide10). */
function orderedEntries(files: Unzipped, pattern: RegExp): string[] {
  return Object.keys(files)
    .filter((name) => pattern.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/)?.[1] ?? 0);
      const nb = Number(b.match(/(\d+)/)?.[1] ?? 0);
      return na - nb;
    });
}

function extractDocx(files: Unzipped): ExtractionResult {
  const doc = files["word/document.xml"];
  if (!doc) return failed("not a valid Word document (no document part)");

  const xml = decode(doc);

  // Paragraph and line breaks become newlines so the text keeps its shape.
  const withBreaks = xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\s*\/>/g, "\n")
    .replace(/<w:tab\s*\/>/g, "\t");

  const text = xmlText(withBreaks, "");
  const paragraphs = (xml.match(/<w:p[\s>]/g) ?? []).length;

  const limited = applyCharLimit(text);

  return {
    status: limited.truncated ? "partial" : "extracted",
    reason: limited.truncated ? "content exceeded the extraction character limit" : undefined,
    text: limited.text,
    chars: limited.chars,
    truncated: limited.truncated,
    metadata: { paragraphs: Math.min(paragraphs, LIMITS.docx.maxParagraphs) },
  };
}

function extractXlsx(files: Unzipped): ExtractionResult {
  const workbook = files["xl/workbook.xml"];
  if (!workbook) return failed("not a valid Excel workbook (no workbook part)");

  // Shared strings are interned separately in xlsx; cell values reference them by index.
  const sharedRaw = files["xl/sharedStrings.xml"];
  const shared: string[] = [];

  if (sharedRaw) {
    const xml = decode(sharedRaw);
    for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(xmlText(match[1], "").slice(0, LIMITS.xlsx.maxCellChars));
    }
  }

  const names = (decode(workbook).match(/<sheet[^>]*name="([^"]*)"/g) ?? [])
    .map((tag) => tag.match(/name="([^"]*)"/)?.[1] ?? "sheet")
    .slice(0, LIMITS.xlsx.maxSheets);

  const sheetFiles = orderedEntries(files, /^xl\/worksheets\/sheet\d+\.xml$/).slice(
    0,
    LIMITS.xlsx.maxSheets
  );

  const units: ExtractionUnit[] = [];
  const chunks: string[] = [];
  let truncatedStructure = false;

  sheetFiles.forEach((entry, index) => {
    const label = names[index] ?? `Sheet${index + 1}`;
    const xml = decode(files[entry]);

    const rows = xml.match(/<row[\s>][\s\S]*?<\/row>/g) ?? [];
    if (rows.length > LIMITS.xlsx.maxRowsPerSheet) truncatedStructure = true;

    const lines: string[] = [];
    let cells = 0;

    for (const row of rows.slice(0, LIMITS.xlsx.maxRowsPerSheet)) {
      const values: string[] = [];

      for (const cell of row.match(/<c[\s>][\s\S]*?(?:<\/c>|\/>)/g) ?? []) {
        if (++cells > LIMITS.xlsx.maxCellsPerSheet) {
          truncatedStructure = true;
          break;
        }

        const isShared = /t="s"/.test(cell);
        const raw = cell.match(/<v>([\s\S]*?)<\/v>/)?.[1];

        if (raw === undefined) {
          // Inline string, or an empty cell.
          const inline = cell.match(/<is>([\s\S]*?)<\/is>/)?.[1];
          if (inline) values.push(xmlText(inline, "").slice(0, LIMITS.xlsx.maxCellChars));
          continue;
        }

        if (isShared) {
          const idx = Number(raw);
          values.push(shared[idx] ?? "");
        } else {
          values.push(raw.slice(0, LIMITS.xlsx.maxCellChars));
        }
      }

      if (values.length) lines.push(values.join("\t"));
    }

    const sheetText = lines.join("\n");
    units.push({ kind: "sheet", label, chars: sheetText.length });
    chunks.push(`# ${label}\n${sheetText}`);
  });

  const limited = applyCharLimit(chunks.join("\n\n"));

  return {
    status: limited.truncated || truncatedStructure ? "partial" : "extracted",
    reason: truncatedStructure
      ? "some rows or cells exceeded the extraction limits"
      : limited.truncated
        ? "content exceeded the extraction character limit"
        : undefined,
    text: limited.text,
    chars: limited.chars,
    truncated: limited.truncated,
    units,
    metadata: { sheets: units.length },
  };
}

function extractPptx(files: Unzipped): ExtractionResult {
  const slideFiles = orderedEntries(files, /^ppt\/slides\/slide\d+\.xml$/);

  if (slideFiles.length === 0) {
    return failed("not a valid PowerPoint file (no slides)");
  }

  const truncatedStructure = slideFiles.length > LIMITS.pptx.maxSlides;
  const units: ExtractionUnit[] = [];
  const chunks: string[] = [];

  slideFiles.slice(0, LIMITS.pptx.maxSlides).forEach((entry, index) => {
    // <a:p> is a paragraph in DrawingML; turning it into a newline keeps bullets apart.
    const text = xmlText(decode(files[entry]).replace(/<\/a:p>/g, "\n"), "");
    const label = `Slide ${index + 1}`;

    units.push({ kind: "slide", label, chars: text.length });
    chunks.push(`# ${label}\n${text}`);
  });

  const limited = applyCharLimit(chunks.join("\n\n"));

  return {
    status: limited.truncated || truncatedStructure ? "partial" : "extracted",
    reason: truncatedStructure
      ? `only the first ${LIMITS.pptx.maxSlides} slides were extracted`
      : limited.truncated
        ? "content exceeded the extraction character limit"
        : undefined,
    text: limited.text,
    chars: limited.chars,
    truncated: limited.truncated,
    units,
    metadata: { slides: slideFiles.length },
  };
}

export const ooxmlParser: Parser = async ({ buffer, filename }) => {
  const unzipped = boundedUnzip(buffer);

  if (!unzipped) {
    return failed("file is not a readable Office document, or exceeds safe expansion limits");
  }

  const { files } = unzipped;
  const lower = filename.toLowerCase();

  // Dispatch on container CONTENT first, so a mislabelled extension still parses as what
  // it actually is rather than failing.
  if (files["word/document.xml"]) return extractDocx(files);
  if (files["xl/workbook.xml"]) return extractXlsx(files);
  if (Object.keys(files).some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return extractPptx(files);

  if (lower.endsWith(".docx")) return failed("not a valid Word document (no document part)");
  if (lower.endsWith(".xlsx")) return failed("not a valid Excel workbook (no workbook part)");
  if (lower.endsWith(".pptx")) return failed("not a valid PowerPoint file (no slides)");

  return failed("archive is not a recognised Office document");
};
