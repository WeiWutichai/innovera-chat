import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { FileStorage, PutResult, StoredMeta } from "./types";

/**
 * Keys this implementation will accept.
 *
 * Deliberately an ALLOWLIST rather than a blocklist of dangerous sequences. A blocklist
 * has to anticipate every encoding of "..", including URL-encoded, unicode-normalised
 * and mixed-separator forms; an allowlist of two alphanumeric segments admits none of
 * them by construction.
 *
 * The keys this application generates are `{userId}/{fileId}`, where userId is a Prisma
 * cuid and fileId is 32 hex characters from randomBytes(16). The pattern is expressed
 * more loosely than that — two alphanumeric segments of 8-64 characters — so the storage
 * layer stays independent of how ids happen to be generated. What it does NOT admit is
 * any separator, dot, or escape sequence.
 *
 * The uploaded filename never participates in the key. It is display metadata only.
 * Storage keys are generated server-side, so a key that fails this test is a bug or an
 * attack, never ordinary input.
 */
const KEY_PATTERN = /^[a-z0-9]{8,64}\/[a-z0-9]{8,64}$/i;

export class LocalDiskStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("storage root must be an absolute path");
    }
    this.root = path.resolve(root);
  }

  /**
   * Two independent checks, both required.
   *
   * The pattern test rejects malformed keys up front. The resolved-path assertion is the
   * backstop: whatever the key contains, the absolute path it produces must still sit
   * under the root. Either alone would be a single point of failure.
   */
  private resolveKey(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error("invalid storage key");
    }

    const resolved = path.resolve(this.root, key);

    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error("resolved path escapes the storage root");
    }

    return resolved;
  }

  async put(key: string, data: Readable | Buffer): Promise<PutResult> {
    const target = this.resolveKey(key);
    await mkdir(path.dirname(target), { recursive: true });

    const hash = createHash("sha256");
    let sizeBytes = 0;

    const source = Buffer.isBuffer(data) ? Readable.from(data) : data;

    // Hashing and counting happen on the bytes that are actually written, not on
    // anything the caller reported, so the recorded checksum and size cannot disagree
    // with what is on disk.
    const measured = new Readable({ read() {} });

    source.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
      measured.push(chunk);
    });
    source.on("end", () => measured.push(null));
    source.on("error", (err) => measured.destroy(err));

    try {
      await pipeline(measured, createWriteStream(target, { mode: 0o640 }));
    } catch (error) {
      // A partial file must never be left behind to be served later.
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }

    return { sizeBytes, checksum: hash.digest("hex") };
  }

  async get(key: string): Promise<Readable> {
    const target = this.resolveKey(key);
    await stat(target); // surface a missing object before a stream is handed out
    return createReadStream(target);
  }

  async head(key: string): Promise<StoredMeta | null> {
    try {
      const s = await stat(this.resolveKey(key));
      return { sizeBytes: s.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    // force: true so deleting an object that is already gone is not an error — delete
    // must be idempotent for the row/blob cleanup path to be safe to retry.
    await rm(this.resolveKey(key), { force: true });
  }
}
