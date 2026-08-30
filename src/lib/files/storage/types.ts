import type { Readable } from "node:stream";

export type StoredMeta = {
  sizeBytes: number;
};

export type PutResult = {
  sizeBytes: number;
  /** Hex sha256 of the bytes actually written. */
  checksum: string;
};

/**
 * The only interface business logic may depend on.
 *
 * Keys are opaque, server-generated identifiers — never a filesystem path and never
 * derived from an uploaded filename. An implementation is free to map a key onto disk,
 * S3, or anything else, and swapping implementations must not require a change outside
 * this directory.
 */
export interface FileStorage {
  put(key: string, data: Readable | Buffer): Promise<PutResult>;
  get(key: string): Promise<Readable>;
  head(key: string): Promise<StoredMeta | null>;
  delete(key: string): Promise<void>;
}
