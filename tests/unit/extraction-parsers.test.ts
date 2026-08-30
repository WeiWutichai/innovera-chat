import { describe, it, expect } from "vitest";
import { runExtraction, selectParser } from "@/lib/extraction/registry";
import { LIMITS } from "@/lib/extraction/limits";
import * as fx from "../setup/fixtures";

const run = (buffer: Buffer, filename: string, mimeType: string) =>
  runExtraction({ buffer, filename, mimeType });

describe("registry selection", () => {
  it.each([
    ["application/pdf", "a.pdf", "pdf"],
    ["image/png", "a.png", "image"],
    ["image/jpeg", "a.jpg", "image"],
    ["text/plain", "a.txt", "text"],
    ["application/zip", "a.docx", "ooxml:docx"],
    ["application/zip", "a.xlsx", "ooxml:xlsx"],
    ["application/zip", "a.pptx", "ooxml:pptx"],
  ])("routes %s / %s to %s", (mime, name, kind) => {
    const selection = selectParser(mime, name);
    expect("kind" in selection && selection.kind).toBe(kind);
  });

  it("declines a plain archive rather than expanding it", () => {
    const selection = selectParser("application/zip", "bundle.zip");
    expect("result" in selection && selection.result.status).toBe("unsupported");
  });

  it("declines unknown binary instead of guessing", () => {
    // Falling back to the text parser would feed arbitrary binaries through a decoder
    // and report mojibake as content.
    const selection = selectParser("application/octet-stream", "mystery.dat");
    expect("result" in selection && selection.result.status).toBe("unsupported");
  });
});

describe("text and code", () => {
  it("extracts plain text", async () => {
    const r = await run(Buffer.from("hello\nworld"), "a.txt", "text/plain");
    expect(r.status).toBe("extracted");
    expect(r.text).toBe("hello\nworld");
    expect(r.chars).toBe(11);
    expect(r.truncated).toBe(false);
  });

  it("treats an empty file as extracted-but-empty, not failed", async () => {
    // The distinction matters: "contains no text" is not "could not be read".
    const r = await run(Buffer.alloc(0), "empty.txt", "text/plain");
    expect(r.status).toBe("extracted");
    expect(r.chars).toBe(0);
  });

  it("extracts Thai text intact", async () => {
    const thai = "สวัสดีครับ ทดสอบระบบ";
    const r = await run(Buffer.from(thai, "utf8"), "th.txt", "text/plain");
    expect(r.text).toBe(thai);
  });

  it("truncates oversized content and reports the true length", async () => {
    const big = "x".repeat(LIMITS.maxChars + 5_000);
    const r = await run(Buffer.from(big), "big.txt", "text/plain");

    expect(r.status).toBe("partial");
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(LIMITS.maxChars);
    // chars is the PRE-truncation count, so accounting stays honest.
    expect(r.chars).toBe(LIMITS.maxChars + 5_000);
  });

  it("rejects content that is not valid UTF-8 rather than returning mojibake", async () => {
    const binary = Buffer.from(Array.from({ length: 500 }, (_, i) => (i % 2 ? 0xff : 0xfe)));
    const r = await run(binary, "broken.txt", "text/plain");

    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/not valid UTF-8/i);
  });

  it("extracts source code as text", async () => {
    const code = "export function add(a: number, b: number) {\n  return a + b;\n}";
    const r = await run(Buffer.from(code), "add.ts", "text/plain");
    expect(r.status).toBe("extracted");
    expect(r.text).toContain("export function add");
  });
});

describe("CSV", () => {
  it("bounds the number of rows retained", async () => {
    const rows = Array.from({ length: LIMITS.csv.maxRows + 200 }, (_, i) => `${i},value${i}`);
    const r = await run(Buffer.from(rows.join("\n")), "big.csv", "text/plain");

    expect(r.status).toBe("partial");
    expect(r.metadata.rows).toBe(rows.length);
    expect(r.metadata.rowsRetained).toBe(LIMITS.csv.maxRows);
    expect(r.text.split("\n").length).toBeLessThanOrEqual(LIMITS.csv.maxRows);
  });

  it("extracts a small CSV in full", async () => {
    const r = await run(Buffer.from("a,b\n1,2\n3,4"), "small.csv", "text/plain");
    expect(r.status).toBe("extracted");
    expect(r.text).toContain("3,4");
  });

  it("accepts a malformed CSV as text rather than failing", async () => {
    // Ragged quoting is extremely common in real exports; refusing it would be worse
    // than storing what is there.
    const r = await run(Buffer.from('a,"unclosed\n1,2'), "ragged.csv", "text/plain");
    expect(["extracted", "partial"]).toContain(r.status);
  });
});

describe("JSON", () => {
  it("marks valid JSON as such without reformatting it", async () => {
    const src = '{\n  "a": 1\n}';
    const r = await run(Buffer.from(src), "a.json", "text/plain");

    expect(r.status).toBe("extracted");
    expect(r.metadata.jsonValid).toBe("true");
    // The user's formatting is part of the content.
    expect(r.text).toBe(src);
  });

  it("stores malformed JSON as text and says so", async () => {
    const r = await run(Buffer.from('{"a": '), "bad.json", "text/plain");

    expect(r.status).toBe("partial");
    expect(r.metadata.jsonValid).toBe("false");
    expect(r.reason).toMatch(/not valid JSON/i);
  });
});

describe("XML and YAML are never interpreted", () => {
  it("does not resolve an external entity", async () => {
    const r = await run(fx.xxeXml(), "payload.xml", "text/plain");

    // The literal entity reference survives; nothing was fetched or expanded.
    expect(r.text).toContain("&xxe;");
    expect(r.text).not.toContain("root:");
    expect(r.text).not.toContain("/bin/");
  });

  it("does not expand a nested entity (billion laughs)", async () => {
    const r = await run(fx.xxeXml(), "payload.xml", "text/plain");

    expect(r.text).toContain("&lol2;");
    // Expansion would multiply "ha" many times over.
    expect(r.text.length).toBeLessThan(500);
  });

  it("extracts YAML as text", async () => {
    const yaml = "name: innovera\nitems:\n  - one\n  - two";
    const r = await run(Buffer.from(yaml), "config.yaml", "text/plain");

    expect(r.status).toBe("extracted");
    expect(r.text).toBe(yaml);
  });
});

describe("PDF", () => {
  it("extracts a text layer", async () => {
    const r = await run(fx.pdfWithText("INNOVERA report body"), "r.pdf", "application/pdf");

    expect(r.status).toBe("extracted");
    expect(r.text).toContain("INNOVERA report body");
    expect(r.metadata.pages).toBe(1);
    expect(r.metadata.textLayer).toBe("present");
  });

  it("reports a scanned PDF as unsupported with an explanation, not empty success", async () => {
    // A blank preview with no explanation would read as a broken feature.
    const r = await run(fx.pdfWithoutText(), "scan.pdf", "application/pdf");

    expect(r.status).toBe("unsupported");
    expect(r.reason).toMatch(/no text layer|scan/i);
    expect(r.metadata.textLayer).toBe("none");
  });

  it("fails cleanly on a malformed PDF", async () => {
    const r = await run(Buffer.from("%PDF-1.4\nnot really a pdf"), "bad.pdf", "application/pdf");

    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/not a readable PDF/i);
  });

  it("never leaks a library message into the reason", async () => {
    const r = await run(Buffer.from("%PDF-garbage"), "bad.pdf", "application/pdf");

    expect(r.reason).not.toMatch(/node_modules|at Object|Error:|\.js:/);
  });
});

describe("DOCX", () => {
  it("extracts paragraph text", async () => {
    const r = await run(fx.docx(["First para", "Second para"]), "d.docx", "application/zip");

    expect(r.status).toBe("extracted");
    expect(r.text).toContain("First para");
    expect(r.text).toContain("Second para");
    expect(r.metadata.paragraphs).toBe(2);
  });

  it("separates paragraphs with newlines", async () => {
    const r = await run(fx.docx(["Alpha", "Beta"]), "d.docx", "application/zip");
    expect(r.text.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it("fails on a zip that is not a Word document", async () => {
    const r = await run(fx.plainZip(), "fake.docx", "application/zip");

    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/Word document/i);
  });

  it("fails on a corrupt container", async () => {
    const r = await run(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]), "c.docx", "application/zip");
    expect(r.status).toBe("failed");
  });
});

describe("XLSX", () => {
  it("extracts multiple sheets with their names", async () => {
    const book = fx.xlsx([
      { name: "Sales", rows: [["Region", "Total"], ["North", "100"]] },
      { name: "Costs", rows: [["Item", "Amount"], ["Rent", "50"]] },
    ]);

    const r = await run(book, "b.xlsx", "application/zip");

    expect(r.status).toBe("extracted");
    expect(r.text).toContain("Sales");
    expect(r.text).toContain("North");
    expect(r.text).toContain("Costs");
    expect(r.metadata.sheets).toBe(2);
  });

  it("reports sheets as units", async () => {
    const r = await run(
      fx.xlsx([{ name: "OnlySheet", rows: [["a"]] }]),
      "b.xlsx",
      "application/zip"
    );

    expect(r.units).toHaveLength(1);
    expect(r.units?.[0]).toMatchObject({ kind: "sheet", label: "OnlySheet" });
  });

  it("bounds rows per sheet", async () => {
    const rows = Array.from({ length: LIMITS.xlsx.maxRowsPerSheet + 50 }, (_, i) => [`r${i}`]);
    const r = await run(fx.xlsx([{ name: "Big", rows }]), "b.xlsx", "application/zip");

    expect(r.status).toBe("partial");
    expect(r.reason).toMatch(/rows or cells/i);
  });

  it("fails on a zip that is not a workbook", async () => {
    const r = await run(fx.plainZip(), "fake.xlsx", "application/zip");
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/workbook/i);
  });
});

describe("PPTX", () => {
  it("extracts slide text in order", async () => {
    const deck = fx.pptx([["Title slide"], ["Second slide", "bullet"]]);
    const r = await run(deck, "d.pptx", "application/zip");

    expect(r.status).toBe("extracted");
    expect(r.text).toContain("Title slide");
    expect(r.text).toContain("Second slide");
    expect(r.metadata.slides).toBe(2);
    expect(r.text.indexOf("Title slide")).toBeLessThan(r.text.indexOf("Second slide"));
  });

  it("reports slides as units", async () => {
    const r = await run(fx.pptx([["one"], ["two"]]), "d.pptx", "application/zip");

    expect(r.units).toHaveLength(2);
    expect(r.units?.[0]).toMatchObject({ kind: "slide", label: "Slide 1" });
  });

  it("orders slide10 after slide2", async () => {
    // Lexical sorting would place slide10 before slide2 and scramble the deck.
    const deck = fx.pptx(Array.from({ length: 11 }, (_, i) => [`content ${i + 1}`]));
    const r = await run(deck, "d.pptx", "application/zip");

    expect(r.text.indexOf("content 2")).toBeLessThan(r.text.indexOf("content 11"));
  });

  it("fails on a zip with no slides", async () => {
    const r = await run(fx.plainZip(), "fake.pptx", "application/zip");
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/PowerPoint|slides/i);
  });
});

describe("zip expansion is bounded", () => {
  it("refuses an OOXML container that inflates beyond the ratio limit", async () => {
    // A document-shaped zip bomb: small on disk, enormous inflated.
    const bomb = fx.compressionBomb(80 * 1024 * 1024);
    const r = await run(bomb, "bomb.docx", "application/zip");

    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/safe expansion limits/i);
  });

  it("never expands a user-supplied archive at all", async () => {
    const r = await run(fx.plainZip({ "a.txt": "x" }), "bundle.zip", "application/zip");

    expect(r.status).toBe("unsupported");
    expect(r.reason).toMatch(/never expanded/i);
    expect(r.text).toBe("");
  });
});

describe("images — metadata only", () => {
  it.each([
    ["png", () => fx.png(800, 600), "image/png"],
    ["gif", () => fx.gif(320, 240), "image/gif"],
    ["jpeg", () => fx.jpeg(1024, 768), "image/jpeg"],
    ["webp", () => fx.webp(640, 480), "image/webp"],
  ])("reads %s dimensions without decoding the image", async (_name, make, mime) => {
    const r = await run(make(), `img.${_name}`, mime);

    expect(r.metadata.width).toBeGreaterThan(0);
    expect(r.metadata.height).toBeGreaterThan(0);
  });

  it("always reports unsupported, never extracted", async () => {
    // The deployed model is text-only. Reporting "extracted" would imply the AI can
    // read the image.
    const r = await run(fx.png(10, 10), "a.png", "image/png");

    expect(r.status).toBe("unsupported");
    expect(r.reason).toMatch(/cannot read image content/i);
    expect(r.text).toBe("");
  });

  it("survives a malformed image header without failing the file", async () => {
    const r = await run(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "trunc.png", "image/png");

    expect(r.status).toBe("unsupported");
    expect(r.metadata.width).toBeUndefined();
  });

  it("retains no EXIF or private metadata", async () => {
    const r = await run(fx.jpeg(100, 50), "photo.jpg", "image/jpeg");
    const keys = Object.keys(r.metadata);

    // GPS coordinates and device serials routinely live in EXIF and are never needed here.
    expect(keys.sort()).toEqual(["bytes", "format", "height", "width"]);
  });
});

describe("failure states are always classified", () => {
  it("never returns a raw error message as the reason", async () => {
    const inputs: Array<[Buffer, string, string]> = [
      [Buffer.from("%PDF-broken"), "a.pdf", "application/pdf"],
      [Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), "a.docx", "application/zip"],
      [Buffer.from([0xff, 0xfe, 0xff, 0xfe]), "a.txt", "text/plain"],
    ];

    for (const [buffer, name, mime] of inputs) {
      const r = await run(buffer, name, mime);
      expect(r.reason ?? "").not.toMatch(/node_modules|TypeError|undefined is not|\.ts:\d/);
    }
  });
});
