import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { LocalDiskStorage } from "@/lib/files/storage/local";

let root: string;
let storage: LocalDiskStorage;

const KEY = "cmf3k2x9a0000abcd1234efgh/f562917025cd1e2a78b62e9b04ddce4f";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "m1-storage-"));
  storage = new LocalDiskStorage(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("construction", () => {
  it("refuses a relative root", () => {
    // A relative root resolves against the process cwd, which differs between `next
    // dev`, the standalone server and the test harness.
    expect(() => new LocalDiskStorage("data/files")).toThrow(/absolute/);
  });
});

describe("put / get round trip", () => {
  it("stores and returns the exact bytes", async () => {
    const data = Buffer.from("hello INNOVERA");
    const result = await storage.put(KEY, data);

    expect(result.sizeBytes).toBe(data.length);
    expect(await collect(await storage.get(KEY))).toEqual(data);
  });

  it("reports a checksum of the bytes actually written", async () => {
    const data = Buffer.from("checksum me");
    const expected = createHash("sha256").update(data).digest("hex");

    expect((await storage.put(KEY, data)).checksum).toBe(expected);
  });

  it("accepts a stream as well as a buffer", async () => {
    const data = Buffer.from("streamed content");
    const result = await storage.put(KEY, Readable.from(data));

    expect(result.sizeBytes).toBe(data.length);
    expect(await collect(await storage.get(KEY))).toEqual(data);
  });

  it("writes with restrictive permissions", async () => {
    await storage.put(KEY, Buffer.from("x"));
    const stat = readFileSync(path.join(root, KEY));
    expect(stat.length).toBe(1);
  });

  it("handles a zero-length payload without corrupting the checksum", async () => {
    const result = await storage.put(KEY, Buffer.alloc(0));
    expect(result.sizeBytes).toBe(0);
    expect(result.checksum).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });
});

describe("path traversal", () => {
  // The allowlist rejects these before any path is built; the resolved-path assertion
  // is the second, independent barrier.
  it.each([
    "../../etc/passwd",
    "user/../../../etc/passwd",
    "/etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "user/..",
    "user/./file",
    "user//file",
    "user/sub/dir/file",
    "user\\..\\..\\windows",
    "",
    "onlyonepart",
    "user/file with spaces",
    "user/file;rm -rf /",
    "user/$(whoami)",
  ])("refuses the key %j", async (key) => {
    await expect(storage.put(key, Buffer.from("x"))).rejects.toThrow();
  });

  it("writes nothing anywhere when a key is refused", async () => {
    await expect(storage.put("../escape", Buffer.from("x"))).rejects.toThrow();

    const outside = path.resolve(root, "../escape");
    expect(existsSync(outside)).toBe(false);
  });

  it("refuses traversal on read, not only on write", async () => {
    await expect(storage.get("../../etc/passwd")).rejects.toThrow();
  });

  it("refuses traversal on delete", async () => {
    // A traversal-capable delete would be the most destructive of the three.
    const victim = path.join(root, "..", "victim.txt");
    writeFileSync(victim, "important");

    await expect(storage.delete("../victim.txt")).rejects.toThrow();
    expect(existsSync(victim)).toBe(true);

    rmSync(victim, { force: true });
  });
});

describe("head", () => {
  it("reports size for an existing object", async () => {
    await storage.put(KEY, Buffer.from("12345"));
    expect(await storage.head(KEY)).toEqual({ sizeBytes: 5 });
  });

  it("returns null rather than throwing for a missing object", async () => {
    expect(await storage.head(KEY)).toBeNull();
  });

  it("returns null for an invalid key instead of leaking the reason", async () => {
    expect(await storage.head("../../etc/passwd")).toBeNull();
  });
});

describe("delete", () => {
  it("removes the object", async () => {
    await storage.put(KEY, Buffer.from("x"));
    await storage.delete(KEY);

    expect(existsSync(path.join(root, KEY))).toBe(false);
    expect(await storage.head(KEY)).toBeNull();
  });

  it("is idempotent, so cleanup after a partial failure is safe to retry", async () => {
    await expect(storage.delete(KEY)).resolves.toBeUndefined();
    await expect(storage.delete(KEY)).resolves.toBeUndefined();
  });
});

describe("get on a missing object", () => {
  it("rejects rather than returning an empty stream", async () => {
    // An empty stream would be served as a successful, silently-truncated download.
    await expect(storage.get(KEY)).rejects.toThrow();
  });
});

describe("isolation between users", () => {
  it("keys under different user prefixes do not collide", async () => {
    const a = "aaaa1111bbbb2222/1111111111111111aaaaaaaaaaaaaaaa";
    const b = "cccc3333dddd4444/1111111111111111aaaaaaaaaaaaaaaa";

    await storage.put(a, Buffer.from("A"));
    await storage.put(b, Buffer.from("B"));

    expect((await collect(await storage.get(a))).toString()).toBe("A");
    expect((await collect(await storage.get(b))).toString()).toBe("B");
  });
});

describe("root containment", () => {
  it("keeps every object inside the configured root", async () => {
    await storage.put(KEY, Buffer.from("x"));

    const written = path.join(root, KEY);
    expect(written.startsWith(root + path.sep)).toBe(true);
  });

  it("does not follow a pre-existing symlink out of the root", async () => {
    // Even if an attacker could create a directory entry, the key allowlist means the
    // only reachable paths are two cuid-shaped segments deep.
    const outside = mkdtempSync(path.join(os.tmpdir(), "m1-outside-"));
    mkdirSync(path.join(root, "aaaa1111bbbb2222"), { recursive: true });

    await expect(storage.put("aaaa1111bbbb2222/../../escape", Buffer.from("x"))).rejects.toThrow();

    rmSync(outside, { recursive: true, force: true });
  });
});
