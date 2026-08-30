import { describe, it, expect } from "vitest";
import {
  sniff,
  checkConsistency,
  sanitizeFilename,
  contentDisposition,
  extensionOf,
} from "@/lib/files/validate";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n", "binary");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a\0\0\0\0", "binary");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0]);
const SEVENZ = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]);
const TEXT = Buffer.from("hello world\nsecond line\n");
const THAI = Buffer.from("สวัสดีครับ นี่คือไฟล์ทดสอบ\n", "utf8");
const BINARY = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f]);

function webp() {
  const b = Buffer.alloc(16);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  return b;
}

describe("magic-byte sniffing", () => {
  it.each([
    [PNG, "image/png"],
    [PDF, "application/pdf"],
    [JPEG, "image/jpeg"],
    [GIF, "image/gif"],
    [ZIP, "application/zip"],
    [GZIP, "application/gzip"],
    [SEVENZ, "application/x-7z-compressed"],
  ])("recognises signature %#", (buf, expected) => {
    const r = sniff(buf as Buffer, "whatever.bin");
    expect(r.mimeType).toBe(expected);
    expect(r.recognised).toBe(true);
  });

  it("recognises webp through its RIFF container", () => {
    expect(sniff(webp(), "x.webp").mimeType).toBe("image/webp");
  });

  it("treats readable text as text/plain", () => {
    expect(sniff(TEXT, "notes.txt").mimeType).toBe("text/plain");
  });

  it("handles UTF-8 Thai text as text, not binary", () => {
    expect(sniff(THAI, "thai.txt").mimeType).toBe("text/plain");
  });

  it("classifies NUL-containing data as opaque binary", () => {
    const r = sniff(BINARY, "mystery.dat");
    expect(r.mimeType).toBe("application/octet-stream");
    expect(r.recognised).toBe(false);
  });

  it("classifies an empty buffer without consulting the client", () => {
    expect(sniff(Buffer.alloc(0), "empty.txt").mimeType).toBe("text/plain");
  });

  it("serves HTML and SVG as text/plain, never as their real type", () => {
    // Serving them as text/html or image/svg+xml from our own origin would turn an
    // upload into stored XSS.
    expect(sniff(Buffer.from("<html><body>hi</body></html>"), "x.html").mimeType).toBe(
      "text/plain"
    );
    expect(sniff(Buffer.from("<svg width='10'></svg>"), "x.svg").mimeType).toBe(
      "text/plain"
    );
  });
});

describe("extension / content consistency", () => {
  it("accepts a matching pair", () => {
    expect(checkConsistency(sniff(PNG, "photo.png"), "photo.png").ok).toBe(true);
  });

  it("rejects a PNG renamed to .pdf", () => {
    const v = checkConsistency(sniff(PNG, "invoice.pdf"), "invoice.pdf");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("mime_mismatch");
  });

  it("rejects binary content renamed to .txt", () => {
    expect(checkConsistency(sniff(PNG, "readme.txt"), "readme.txt").ok).toBe(false);
  });

  it("accepts docx/xlsx/pptx, which are legitimately ZIP containers", () => {
    for (const name of ["report.docx", "sheet.xlsx", "deck.pptx", "bundle.zip"]) {
      expect(checkConsistency(sniff(ZIP, name), name).ok).toBe(true);
    }
  });

  it("allows unrecognised bytes through — 'unknown' is a valid M1 outcome", () => {
    expect(checkConsistency(sniff(BINARY, "mystery.dat"), "mystery.dat").ok).toBe(true);
  });

  it("allows a file with no extension", () => {
    expect(checkConsistency(sniff(TEXT, "LICENSE"), "LICENSE").ok).toBe(true);
  });
});

describe("filename sanitisation", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32\\cmd.exe", "cmd.exe"],
    ["/absolute/path/file.txt", "file.txt"],
    ["....//....//evil.sh", "evil.sh"],
  ])("strips directory components from %s", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it.each(["..", ".", "", "   "])("replaces the meaningless name '%s'", (input) => {
    expect(sanitizeFilename(input)).toBe("unnamed");
  });

  it("removes quotes that could break a header", () => {
    expect(sanitizeFilename('re"port.txt')).toBe("report.txt");
  });

  it("removes control characters", () => {
    const withControls = "re" + String.fromCharCode(13, 10, 0) + "port.txt";
    expect(sanitizeFilename(withControls)).toBe("report.txt");
  });

  it("preserves Thai and other non-ASCII names", () => {
    expect(sanitizeFilename("รายงานประจำปี.pdf")).toBe("รายงานประจำปี.pdf");
  });

  it("bounds absurd lengths", () => {
    expect(sanitizeFilename("a".repeat(5000)).length).toBe(255);
  });
});

describe("Content-Disposition", () => {
  it("is always attachment, never inline", () => {
    expect(contentDisposition("page.html")).toMatch(/^attachment;/);
  });

  it("emits both an ASCII fallback and a UTF-8 form", () => {
    const v = contentDisposition("รายงาน.pdf");
    expect(v).toContain('filename="');
    expect(v).toContain("filename*=UTF-8''");
    expect(v).toContain(encodeURIComponent("รายงาน.pdf"));
  });

  it("cannot be broken out of with quotes or newlines", () => {
    const hostile = 'evil".txt' + String.fromCharCode(13, 10) + "X-Injected: 1";
    const v = contentDisposition(hostile);

    expect(v).not.toContain(String.fromCharCode(13));
    expect(v).not.toContain(String.fromCharCode(10));
    // Exactly the two quotes that delimit the ASCII filename parameter.
    expect(v.match(/"/g)?.length).toBe(2);
  });

  it("strips directory traversal before it reaches a header", () => {
    expect(contentDisposition("../../secret.txt")).toContain('filename="secret.txt"');
  });
});

describe("extensionOf", () => {
  it.each([
    ["a.txt", "txt"],
    ["archive.TAR.GZ", "gz"],
    ["noext", ""],
    [".gitignore", ""],
    ["path/to/file.TS", "ts"],
  ])("%s -> '%s'", (input, expected) => {
    expect(extensionOf(input)).toBe(expected);
  });
});
