import type { Parser } from "@/lib/extraction/types";
import { unsupported } from "@/lib/extraction/types";

/**
 * Images — DIMENSIONS ONLY.
 *
 * Status is deliberately "unsupported", not "extracted": the deployed model is text-only,
 * so there is no interpretation of this file's content and the UI must not imply there
 * is. No OCR, no vision, and no image bytes ever leave the server for the LLM.
 *
 * Dimensions are read straight from the format headers rather than through a dependency.
 * That is a few lines per format, needs no decoder, and cannot be induced to allocate a
 * frame buffer by a hostile file — a decoding library is exactly where image parsers
 * have historically been exploited.
 *
 * EXIF is deliberately NOT read or retained. It routinely carries GPS coordinates,
 * device serial numbers and timestamps, none of which this feature needs.
 */

type Dimensions = { width: number; height: number } | null;

function png(b: Buffer): Dimensions {
  // IHDR is always the first chunk: width and height are big-endian at offsets 16/20.
  if (b.length < 24) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b: Buffer): Dimensions {
  if (b.length < 10) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpeg(b: Buffer): Dimensions {
  // Walk the segment chain to a Start-Of-Frame marker, which carries the real size.
  let offset = 2;

  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return null;

    const marker = b[offset + 1];
    const length = b.readUInt16BE(offset + 2);

    // SOF0..SOF15, excluding the non-frame markers DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
    }

    offset += 2 + length;
  }

  return null;
}

function webp(b: Buffer): Dimensions {
  if (b.length < 30) return null;

  const format = b.toString("ascii", 12, 16);

  if (format === "VP8 ") {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }

  if (format === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }

  if (format === "VP8X") {
    return {
      width: (b.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (b.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }

  return null;
}

export const imageParser: Parser = async ({ buffer, mimeType }) => {
  let dimensions: Dimensions = null;

  try {
    if (mimeType === "image/png") dimensions = png(buffer);
    else if (mimeType === "image/gif") dimensions = gif(buffer);
    else if (mimeType === "image/jpeg") dimensions = jpeg(buffer);
    else if (mimeType === "image/webp") dimensions = webp(buffer);
  } catch {
    // A malformed header is not an error worth failing on — the file is still stored,
    // downloadable and previewable; only its dimensions are unknown.
    dimensions = null;
  }

  const metadata: Record<string, string | number> = { bytes: buffer.length, format: mimeType };

  if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
    metadata.width = dimensions.width;
    metadata.height = dimensions.height;
  }

  return unsupported(
    "images are stored and previewable, but the current AI cannot read image content",
    metadata
  );
};
