"use client";

import type { BookSource } from "@/lib/types";
import { BookCover } from "./BookCover";

export function BookCard({ book, index, onAsk }: { book: BookSource; index: number; onAsk?: (q: string) => void }) {
  const authors = book.authors.length ? book.authors.slice(0, 2).join(", ") + (book.authors.length > 2 ? " et al." : "") : "Unknown author";
  const year = book.firstPublishYear ?? (book.firstPublishDate ? book.firstPublishDate : undefined);
  const blurb = book.description;
  // Skip Open Library's machine tags ("series:Harry_Potter", "nyt:...=2008-01-01") and very long subjects.
  const subjects = (book.subjects ?? [])
    .filter((s) => s.length < 32 && !/[:=]/.test(s))
    .map((s) => s.replace(/_/g, " "))
    .slice(0, 3);

  return (
    <article className="fade-up group flex w-full gap-3 rounded-xl border border-line bg-surface/70 p-3 transition duration-200 hover:-translate-y-0.5 hover:border-ink-3/40 hover:bg-surface hover:shadow-[0_10px_28px_-14px_rgb(var(--shadow)/0.35)]">
      <div className="relative shrink-0">
        <BookCover coverId={book.coverId} coverImage={book.coverImage} title={book.title} className="h-[108px] w-[72px]" />
        <span className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-[10px] font-semibold text-paper shadow">
          {index + 1}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="line-clamp-2 font-serif text-[15px] font-semibold leading-snug" title={book.title}>
          {book.title}
          {book.subtitle && <span className="font-normal text-ink-2">: {book.subtitle}</span>}
        </h3>
        <p className="mt-0.5 truncate text-[13px] text-ink-2">{authors}</p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          {book.releaseDate ? `Ebook released ${book.releaseDate.slice(0, 4)}` : year ? `First published ${year}` : "Publication year unknown"}
          {book.editionCount ? ` · ${book.editionCount} edition${book.editionCount === 1 ? "" : "s"}` : ""}
        </p>
        {blurb ? (
          <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-ink-2">{blurb}</p>
        ) : subjects.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {subjects.map((s) => (
              <span key={s} className="rounded-full bg-paper-2 px-2 py-0.5 text-[11px] text-ink-2">
                {s}
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-auto flex items-center gap-3 pt-2 text-[12px]">
          <a href={book.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
            {book.sourceName} ↗
          </a>
          {onAsk && (
            <button
              type="button"
              onClick={() => onAsk(`Tell me more about "${book.title}"${book.authors[0] ? ` by ${book.authors[0]}` : ""}.`)}
              className="text-ink-2 opacity-0 transition hover:text-ink hover:underline group-hover:opacity-100 focus:opacity-100 max-sm:opacity-100"
            >
              Tell me more
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
