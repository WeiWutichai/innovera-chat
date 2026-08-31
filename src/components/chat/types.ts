/** Shared shapes for the chat UI. Kept in one place so the split components agree. */

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

export type Conversation = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A file as the chat UI sees it.
 *
 * Metadata only. `extractedText` is deliberately absent: no endpoint the browser calls
 * returns file content into this component tree, so a rendering mistake cannot leak one
 * file's text into another view.
 */
export type AttachedFile = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractStatus: string;
  extractReason?: string | null;
  extractTruncated?: boolean;
  createdAt?: string;
};

export type ChatErrorBody = {
  error?: string;
  reason?: string;
  correlationId?: string;
  conversationId?: string | null;
};

/** A failing response often carries HTML, not JSON. Never parse before checking status. */
export async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
