import { storageRoot } from "@/lib/files/config";
import { LocalDiskStorage } from "./local";
import type { FileStorage } from "./types";

let cached: FileStorage | null = null;

/**
 * The single place an implementation is chosen. Swapping to S3/MinIO later changes this
 * function and nothing else.
 */
export function getStorage(): FileStorage {
  if (!cached) cached = new LocalDiskStorage(storageRoot());
  return cached;
}

/** Test-only: forces the next getStorage() to re-read configuration. */
export function __resetStorage() {
  cached = null;
}
