"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { processCitations } from "@/lib/citations";
import type { BookSource, ChatMessage } from "@/lib/types";
import { CitationChip } from "./CitationChip";
import { BookCard } from "./BookCard";

interface Props {
  message: ChatMessage;
  sources: Record<string, BookSource>;
  streaming: boolean;
  status: string | null;
  onAsk: (q: string) => void;
  onRetry?: () => void;
}

function AssistantMessageImpl({ message, sources, streaming, status, onAsk, onRetry }: Props) {
  const { markdown, order } = useMemo(
    () => processCitations(message.content, (id) => !!sources[id], { streaming }),
    [message.content, sources, streaming],
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        if (href === "#cite-more") {
          return (
            <span className="mx-[1px] align-middle text-[10.5px] font-medium text-ink-3" title="More records support this sentence">
              {children}
            </span>
          );
        }
        if (href?.startsWith("#cite-")) {
          const id = href.slice(6);
          return <CitationChip n={order.indexOf(id) + 1} source={sources[id]} />;
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="ext">
            {children}
          </a>
        );
      },
    }),
    [order, sources],
  );

  const books = (message.bookIds ?? []).map((id) => sources[id]).filter((b): b is BookSource => !!b);
  const empty = !message.content;

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink font-serif text-[13px] font-semibold text-paper">
        S
      </div>
      <div className="min-w-0 flex-1">
        {empty && streaming ? (
          <div className="flex h-7 items-center gap-2 text-[13.5px] text-ink-3" role="status" aria-live="polite">
            <span className="flex gap-1">
              <span className="dot h-1.5 w-1.5 rounded-full bg-ink-3" />
              <span className="dot h-1.5 w-1.5 rounded-full bg-ink-3" />
              <span className="dot h-1.5 w-1.5 rounded-full bg-ink-3" />
            </span>
            <span>{status ?? "Thinking…"}</span>
          </div>
        ) : (
          !empty && (
            <div className={`prose-chat ${streaming ? "caret" : ""}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {markdown}
              </ReactMarkdown>
            </div>
          )
        )}

        {streaming && !empty && status && (
          <div className="mt-2 text-[12.5px] text-ink-3" role="status">
            {status}
          </div>
        )}

        {books.length > 0 && (
          <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {books.map((b, i) => (
              <BookCard key={b.id} book={b} index={i} onAsk={streaming ? undefined : onAsk} />
            ))}
          </div>
        )}

        {message.error && (
          <div className="mt-3 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[13.5px] text-red-800" role="alert">
            <span className="mt-[1px]">⚠</span>
            <div className="flex-1">
              <div>{message.error}</div>
              {onRetry && message.error !== "Stopped." && (
                <button onClick={onRetry} className="mt-1 font-medium underline underline-offset-2 hover:no-underline">
                  Try again
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const AssistantMessage = memo(AssistantMessageImpl);
