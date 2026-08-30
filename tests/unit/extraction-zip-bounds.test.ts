import { describe, it, expect } from "vitest";
import { zipSync } from "fflate";
import { ooxmlParser } from "@/lib/extraction/parsers/ooxml";
import { LIMITS } from "@/lib/extraction/limits";

/**
 * ZIP bounds are applied BEFORE inflation, not after.
 *
 * This distinction is not cosmetic and it is not observable from the return value: a
 * bomb is rejected either way. What changes is whether the archive was expanded into the
 * heap first. The original implementation called `unzipSync` and measured the result,
 * which meant a file declaring gigabytes of content was already resident in memory by
 * the time it was refused — the bomb had already done its work.
 *
 * Memory is therefore the only honest discriminator — and specifically RSS, not
 * heapUsed. fflate inflates into ArrayBuffers, which live outside the JS heap, and by
 * the time the call returns GC has usually already reclaimed them, so both heapUsed and
 * arrayBuffers read as ~0 whether the archive was expanded or not. RSS still shows the
 * memory the process actually took from the OS.
 *
 * Measured both ways: with the pre-inflation filter this fixture costs 0.0 MB of RSS,
 * without it 121.5 MB. The assertion sits at 40 MB, a 3x margin.
 */

const INFLATED = 120 * 1024 * 1024;

describe("zip expansion bounds", () => {
  it("rejects an oversized entry without inflating it", () => {
    // One entry, far above LIMITS.zip.maxEntryBytes, and hugely compressible.
    let bomb: Buffer | null = Buffer.from(
      zipSync(
        { "word/document.xml": new TextEncoder().encode("A".repeat(INFLATED)) },
        { level: 9 }
      )
    );

    expect(INFLATED).toBeGreaterThan(LIMITS.zip.maxEntryBytes);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024); // the archive itself is tiny

    global.gc?.();
    const before = process.memoryUsage().rss;

    const result = ooxmlParser({
      buffer: bomb,
      filename: "bomb.docx",
      mimeType: "application/zip",
    });

    const deltaMb = (process.memoryUsage().rss - before) / 1024 / 1024;
    bomb = null;

    return result.then((r) => {
      expect(r.status).not.toBe("extracted");
      // The bomb was refused on its declared size, so those 120 MB were never taken.
      expect(deltaMb).toBeLessThan(40);
    });
  });

  it("still rejects a bomb whose declared sizes are within limits", async () => {
    // Defence in depth: declared sizes come from the archive and are attacker
    // controlled, so the post-inflation check remains the authoritative one.
    const ratioBomb = Buffer.from(
      zipSync(
        { "word/document.xml": new TextEncoder().encode("B".repeat(8 * 1024 * 1024)) },
        { level: 9 }
      )
    );

    const r = await ooxmlParser({
      buffer: ratioBomb,
      filename: "bomb.docx",
      mimeType: "application/zip",
    });

    // 8 MB from a few KB is far past the 200:1 ratio ceiling.
    expect(r.status).not.toBe("extracted");
  });

  it("still parses a legitimate document", async () => {
    const good = Buffer.from(
      zipSync({
        "[Content_Types].xml": new TextEncoder().encode('<?xml version="1.0"?><Types/>'),
        "word/document.xml": new TextEncoder().encode(
          '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>'
        ),
      })
    );

    const r = await ooxmlParser({
      buffer: good,
      filename: "ok.docx",
      mimeType: "application/zip",
    });

    // The bounds must not be so eager that ordinary documents trip them.
    expect(r.status).toBe("extracted");
    expect(r.text).toContain("hello");
  });
});
