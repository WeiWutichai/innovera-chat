"use client";

import { useCallback, useMemo, useState } from "react";
import { readJson, type AttachedFile } from "@/components/chat/types";

/**
 * Attachment state, split into the two concepts the server distinguishes.
 *
 *   ASSOCIATED  every file ever attached to this conversation. Persisted as
 *               ConversationFile rows, restored on reload, and the pool the user
 *               re-selects from.
 *   ACTIVE      the subset selected for the NEXT message. Only these are sent as
 *               `fileIds`, and only these contribute text to the prompt.
 *
 * Collapsing the two would mean a document attached once was re-read on every later turn,
 * silently spending half the context budget forever.
 *
 * AFTER SEND THE ACTIVE SELECTION IS KEPT. The common case is several questions about the
 * same document ("summarise this", then "what about the second sheet"), and clearing the
 * selection would make the second question silently unanchored — the model would answer
 * about nothing while the user still saw the file in the conversation. Keeping it means
 * the visible chips always match what the next message will actually read; removing a
 * chip is one click and is the only way the selection changes.
 *
 * Nothing here is authority for anything. The server re-checks every id against the
 * signed-in user, so this state is a request, never a claim about what may be read.
 */
export function useAttachments(conversationId: string | null) {
  const [associated, setAssociated] = useState<AttachedFile[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** Active files, in association order, so the composer order matches the prompt order. */
  const active = useMemo(
    () => associated.filter((f) => activeIds.includes(f.id)),
    [associated, activeIds]
  );

  const inactive = useMemo(
    () => associated.filter((f) => !activeIds.includes(f.id)),
    [associated, activeIds]
  );

  const merge = useCallback((incoming: AttachedFile[]) => {
    setAssociated((prev) => {
      const seen = new Set(prev.map((f) => f.id));
      return [...prev, ...incoming.filter((f) => !seen.has(f.id))];
    });
  }, []);

  /** Selects files: associates them if possible, and marks them active for the next turn. */
  const attach = useCallback(
    async (fileIds: string[]) => {
      if (fileIds.length === 0) return;

      setError(null);
      setActiveIds((prev) => [...new Set([...prev, ...fileIds])]);

      // A brand-new chat has no conversation to associate with yet. The ids ride along
      // with the first send and the server associates them inside the authorized path.
      if (!conversationId) {
        try {
          const res = await fetch("/api/files", { cache: "no-store" });
          const data = await readJson<{ files?: AttachedFile[] }>(res);
          merge((data?.files ?? []).filter((f) => fileIds.includes(f.id)));
        } catch {
          setError("ไม่สามารถแนบไฟล์ได้");
        }

        return;
      }

      try {
        const res = await fetch(`/api/conversations/${conversationId}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileIds }),
        });

        if (!res.ok) {
          setError("ไม่สามารถแนบไฟล์ได้");
          setActiveIds((prev) => prev.filter((id) => !fileIds.includes(id)));
          return;
        }

        const data = await readJson<{ attachments?: AttachedFile[] }>(res);
        if (data?.attachments) setAssociated(data.attachments);
      } catch {
        setError("ไม่สามารถแนบไฟล์ได้");
      }
    },
    [conversationId, merge]
  );

  /** Drops a file from the NEXT message only. It stays associated and re-selectable. */
  const deactivate = useCallback((fileId: string) => {
    setActiveIds((prev) => prev.filter((id) => id !== fileId));
  }, []);

  /** Re-selects a file already associated with this conversation. */
  const activate = useCallback((fileId: string) => {
    setActiveIds((prev) => (prev.includes(fileId) ? prev : [...prev, fileId]));
  }, []);

  /** Removes the association entirely. Never deletes the file itself. */
  const detach = useCallback(
    async (fileId: string) => {
      setActiveIds((prev) => prev.filter((id) => id !== fileId));
      setAssociated((prev) => prev.filter((f) => f.id !== fileId));

      if (!conversationId) return;

      try {
        await fetch(`/api/conversations/${conversationId}/files/${fileId}`, {
          method: "DELETE",
        });
      } catch {
        // Already gone locally; the next open resyncs from the server.
      }
    },
    [conversationId]
  );

  /**
   * Restores a conversation's association on open.
   *
   * Nothing becomes active. Reopening a conversation must not silently re-send documents
   * to the model — the user chooses what the next question reads.
   */
  const hydrate = useCallback((files: AttachedFile[]) => {
    setAssociated(files);
    setActiveIds([]);
  }, []);

  const reset = useCallback(() => {
    setAssociated([]);
    setActiveIds([]);
    setError(null);
  }, []);

  return {
    associated,
    active,
    inactive,
    activeIds,
    attach,
    activate,
    deactivate,
    detach,
    hydrate,
    reset,
    error,
    setError,
  };
}
