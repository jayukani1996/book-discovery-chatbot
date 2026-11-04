"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "./useChat";
import { AssistantMessage } from "./AssistantMessage";

const EXAMPLES = [
  "Find books by J.K. Rowling",
  "Find introductory books about artificial intelligence",
  "Who wrote Kindred and when was it first published?",
  "Recommend three books about startups for a beginner",
  "When was The Left Hand of Darkness first published?",
  "Show me books by Ursula K. Le Guin with cover images",
];

export function Chat() {
  const { messages, sources, status, loading, send, retry, stop, reset } = useChat();
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  // Auto-scroll while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [input]);

  const submit = (text = input) => {
    if (!text.trim() || loading) return;
    stick.current = true;
    send(text);
    setInput("");
    textarea.current?.focus();
  };

  const lastId = messages[messages.length - 1]?.id;
  const hasFollowUps = messages.some((m) => m.role === "assistant" && m.bookIds?.length);

  return (
    <div className="flex h-dvh flex-col">
      <header className="shrink-0 border-b border-line/80 bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <div className="flex items-baseline gap-2.5">
            <span className="font-serif text-xl font-semibold tracking-tight">Shelf</span>
            <span className="hidden text-[13px] text-ink-3 sm:inline">Book discovery, grounded in Open Library</span>
          </div>
          {messages.length > 0 && (
            <button
              onClick={() => {
                reset();
                setInput("");
              }}
              className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-white"
            >
              New chat
            </button>
          )}
        </div>
      </header>

      <main
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="scrollbar-thin flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl px-4 py-8">
          {messages.length === 0 ? (
            <EmptyState onPick={submit} />
          ) : (
            <div className="space-y-8">
              {messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="fade-up flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[15px] text-paper">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <AssistantMessage
                    key={m.id}
                    message={m}
                    sources={sources}
                    streaming={loading && m.id === lastId}
                    status={m.id === lastId ? status : null}
                    onAsk={submit}
                    onRetry={m.id === lastId ? retry : undefined}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="shrink-0 border-t border-line/80 bg-paper">
        <div className="mx-auto max-w-3xl px-4 pb-4 pt-3">
          {hasFollowUps && !loading && (
            <div className="scrollbar-thin mb-2 flex gap-1.5 overflow-x-auto pb-1">
              {["Tell me more about the second result", "Only show books with cover images", "Which of these would be best for a beginner?", "Which of these sold the most copies last year?"].map((q) => (
                <button
                  key={q}
                  onClick={() => submit(q)}
                  className="shrink-0 rounded-full border border-line bg-white/60 px-3 py-1 text-[12.5px] text-ink-2 transition hover:border-ink-3/40 hover:bg-white"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex items-end gap-2 rounded-2xl border border-line bg-white p-2 shadow-sm transition focus-within:border-ink-3/50 focus-within:shadow-md"
          >
            <label htmlFor="chat-input" className="sr-only">
              Ask about books
            </label>
            <textarea
              id="chat-input"
              ref={textarea}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              maxLength={2000}
              placeholder={messages.length ? "Ask a follow-up…" : "Ask about books, authors or topics…"}
              className="max-h-[180px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] outline-none placeholder:text-ink-3"
              autoFocus
            />
            {loading ? (
              <button
                type="button"
                onClick={stop}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-line px-3 text-[13px] text-ink-2 transition hover:bg-paper-2"
              >
                <span className="h-2.5 w-2.5 rounded-[2px] bg-ink-2" /> Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                aria-label="Send message"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink text-paper transition hover:bg-ink/85 disabled:cursor-not-allowed disabled:bg-line disabled:text-ink-3"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path d="M10 3.5a.75.75 0 0 1 .53.22l5 5a.75.75 0 1 1-1.06 1.06l-3.72-3.72v9.69a.75.75 0 0 1-1.5 0V6.06L5.53 9.78a.75.75 0 0 1-1.06-1.06l5-5A.75.75 0 0 1 10 3.5Z" />
                </svg>
              </button>
            )}
          </form>
          <p className="mt-2 text-center text-[11.5px] text-ink-3">
            Facts come from Open Library and are cited inline. Opinions are labeled as AI suggestions.
          </p>
        </div>
      </footer>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="fade-up pt-[8vh] text-center">
      <h1 className="font-serif text-[34px] font-semibold leading-tight tracking-tight">What would you like to read?</h1>
      <p className="mx-auto mt-3 max-w-md text-[15px] text-ink-2">
        Search by author, title or topic. Every fact links back to its Open Library record — hover a citation to check it.
      </p>
      <div className="mx-auto mt-8 grid max-w-xl gap-2 sm:grid-cols-2">
        {EXAMPLES.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="rounded-xl border border-line bg-white/60 px-4 py-3 text-left text-[14px] text-ink-2 transition hover:border-ink-3/40 hover:bg-white hover:text-ink"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
