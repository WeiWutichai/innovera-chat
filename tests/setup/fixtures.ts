import { zipSync } from "fflate";

/**
 * Fixture builders.
 *
 * Every fixture is constructed in code rather than committed as a binary. A repository
 * of opaque .docx/.pdf blobs is impossible to review — a reader cannot tell a valid
 * fixture from a malicious one — and these builders make the exact structure each test
 * depends on visible at the point of use.
 */

const enc = (s: string) => new TextEncoder().encode(s);

export function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": enc('<?xml version="1.0"?><Types/>'),
      "word/document.xml": enc(
        `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`
      ),
    })
  );
}

export function xlsx(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
  const shared: string[] = [];
  const indexOf = (value: string) => {
    const existing = shared.indexOf(value);
    if (existing >= 0) return existing;
    shared.push(value);
    return shared.length - 1;
  };

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": enc('<?xml version="1.0"?><Types/>'),
  };

  sheets.forEach((sheet, i) => {
    const rows = sheet.rows
      .map(
        (row) =>
          `<row>${row
            .map((cell) => `<c t="s"><v>${indexOf(cell)}</v></c>`)
            .join("")}</row>`
      )
      .join("");

    files[`xl/worksheets/sheet${i + 1}.xml`] = enc(
      `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`
    );
  });

  files["xl/workbook.xml"] = enc(
    `<?xml version="1.0"?><workbook><sheets>${sheets
      .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"/>`)
      .join("")}</sheets></workbook>`
  );

  files["xl/sharedStrings.xml"] = enc(
    `<?xml version="1.0"?><sst>${shared.map((v) => `<si><t>${v}</t></si>`).join("")}</sst>`
  );

  return Buffer.from(zipSync(files));
}

export function pptx(slides: string[][]): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": enc('<?xml version="1.0"?><Types/>'),
  };

  slides.forEach((paragraphs, i) => {
    const body = paragraphs.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join("");
    files[`ppt/slides/slide${i + 1}.xml`] = enc(
      `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
    );
  });

  return Buffer.from(zipSync(files));
}

/** A zip that is a valid archive but not any Office format. */
export function plainZip(entries: Record<string, string> = { "readme.txt": "hello" }): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) files[name] = enc(content);
  return Buffer.from(zipSync(files));
}

/**
 * A zip whose entries inflate far beyond the archive size — the shape of a zip bomb.
 * Highly compressible input keeps the fixture small while the inflated total is large.
 */
export function compressionBomb(inflatedBytes: number): Buffer {
  return Buffer.from(
    zipSync({ "word/document.xml": enc("A".repeat(inflatedBytes)) }, { level: 9 })
  );
}

/** A minimal PDF with a real text layer. */
export function pdfWithText(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;

  return Buffer.from(
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${stream.length}>>stream
${stream}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`,
    "latin1"
  );
}

/** A structurally valid PDF page with no text operators — the shape of a scan. */
export function pdfWithoutText(): Buffer {
  return Buffer.from(
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj
4 0 obj<</Length 0>>stream

endstream
endobj
trailer<</Size 5/Root 1 0 R>>
%%EOF`,
    "latin1"
  );
}

/** Minimal valid image headers, sufficient for dimension reads. */
export function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(14);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

export function jpeg(width: number, height: number): Buffer {
  // SOI, then a single SOF0 segment carrying the dimensions.
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffc0, 2);
  b.writeUInt16BE(11, 4); // segment length
  b[6] = 8; // precision
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

export function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b.writeUInt16LE(width & 0x3fff, 26);
  b.writeUInt16LE(height & 0x3fff, 28);
  return b;
}

/** XML carrying an external-entity payload — the classic XXE probe. */
export function xxeXml(): Buffer {
  return Buffer.from(
    `<?xml version="1.0"?>
<!DOCTYPE data [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
  <!ENTITY lol "ha">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<data>&xxe; &lol2;</data>`
  );
}
