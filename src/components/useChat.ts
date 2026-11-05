"use client";

import { AnswerStalledError, postWithRetry, readOrStall } from "@/lib/postWithRetry";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BookSource, ChatMessage, StreamEvent } from "@/lib/types";

const STORAGE_KEY = "shelf-chat-v1";

interface Persisted {
  messages: ChatMessage[];
  sources: Record<string, BookSource>;
}

const uid = () => Math.random().toString(36).slice(2, 10);

// The server always speaks within this long: it has its own limits and sends status updates.
const ANSWER_STALL_MS = 20_000;

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sources, setSources] = useState<Record<string, BookSource>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  // State (not a ref) so the save effect can't run before the restored conversation is applied.
  const [hydrated, setHydrated] = useState(false);

  // Restore the conversation after a refresh.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Persisted;
        if (Array.isArray(p.messages)) setMessages(p.messages.filter((m) => m.content || m.error));
        if (p.sources && typeof p.sources === "object") setSources(p.sources);
      }
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || loading) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, sources } satisfies Persisted));
    } catch {}
  }, [messages, sources, loading, hydrated]);

  const run = useCallback(async (history: ChatMessage[]) => {
    const assistantId = uid();
    setMessages([...history, { id: assistantId, role: "assistant", content: "" }]);
    setLoading(true);
    setStatus("Thinking…");

    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

    for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await postWithRetry("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          messages: history
            .filter((m) => !m.error && m.content.trim())
            .map(({ role, content, bookIds }) => ({ role, content, bookIds })),
          sources: sourcesRef.current,
        }),
      });

      if (!res.ok || !res.body) {
        let msg = `The server returned an error (HTTP ${res.status}).`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let gotError: string | null = null;

      const handle = (e: StreamEvent) => {
        switch (e.type) {
          case "status":
            setStatus(e.message);
            break;
          case "sources":
            setSources((prev) => {
              const next = { ...prev };
              for (const s of e.sources) next[s.id] = s;
              return next;
            });
            break;
          case "text":
            setStatus(null);
            patch((m) => ({ ...m, content: m.content + e.delta }));
            break;
          case "reset":
            patch((m) => ({ ...m, content: e.content }));
            break;
          case "books":
            patch((m) => ({ ...m, bookIds: e.ids }));
            break;
          case "error":
            gotError = e.message;
            break;
        }
      };

      for (;;) {
        const { done, value } = await readOrStall(reader, ANSWER_STALL_MS);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            handle(JSON.parse(line) as StreamEvent);
          } catch {}
        }
      }
      if (gotError) throw new Error(gotError);
      break;
    } catch (err) {
      if (err instanceof AnswerStalledError) ctrl.abort();
      if (err instanceof AnswerStalledError && attempt === 0) {
        // Start the answer again from nothing rather than leave the user waiting.
        patch((m) => ({ ...m, content: "", bookIds: undefined }));
        setStatus("Still working on it…");
        continue;
      }
      const aborted = (err as Error)?.name === "AbortError";
      const message = aborted
        ? "Stopped."
        : err instanceof TypeError
          ? "Couldn't reach the server. Check your connection and try again."
          : (err as Error)?.message || "Something went wrong.";
      patch((m) => ({ ...m, error: message }));
      break;
    }
    }
    setLoading(false);
    setStatus(null);
    abortRef.current = null;
  }, []);

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || loading) return;
      const history = [...messages.filter((m) => !(m.role === "assistant" && !m.content && m.error)), { id: uid(), role: "user" as const, content }];
      void run(history);
    },
    [messages, loading, run],
  );

  /** Re-run the last user message (after an error). */
  const retry = useCallback(() => {
    if (loading) return;
    const lastUser = [...messages].reverse().findIndex((m) => m.role === "user");
    if (lastUser < 0) return;
    const cut = messages.length - lastUser;
    void run(messages.slice(0, cut));
  }, [messages, loading, run]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setSources({});
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

  return { messages, sources, status, loading, send, retry, stop, reset };
}
