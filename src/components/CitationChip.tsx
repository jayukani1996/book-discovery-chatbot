"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BookSource } from "@/lib/types";
import { BookCover } from "./BookCover";
import { consistentPublishDate } from "@/lib/format";

const W = 300;

/**
 * Inline citation marker. Hover (desktop) or tap/click (touch) to open a
 * preview of the supporting book record with a link to the source.
 */
export function CitationChip({ n, source }: { n: number; source?: BookSource }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8);
    // Anchor with bottom (not a transform): the entrance animation animates transform and would override it.
    setPos(r.top > 260 ? { left, bottom: window.innerHeight - r.top + 8 } : { left, top: r.bottom + 8 });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (setOpen(false), setPinned(false));
    const onMove = () => place();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  const enter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const leave = () => {
    if (pinned) return;
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  if (!source) return null;

  const authors = source.authors.length ? source.authors.join(", ") : "Not listed";
  const published = consistentPublishDate(source) ?? "Not listed";

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={`Source ${n}: ${source.title}`}
        aria-expanded={open}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={enter}
        onBlur={leave}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setOpen(false);
          } else {
            setPinned(true);
            setOpen(true);
          }
        }}
        className={`mx-[1px] inline-flex h-[17px] min-w-[17px] -translate-y-[1px] items-center justify-center rounded-[5px] px-1 align-middle text-[10.5px] font-semibold leading-none transition ${
          open ? "bg-accent text-on-accent" : "bg-accent-soft text-accent hover:bg-accent hover:text-on-accent"
        }`}
      >
        {n}
      </button>
      {open &&
        pos &&
        // Portal: the preview contains block elements, which can't live inside the answer's <p>.
        createPortal(
        <div
          ref={pop}
          role="dialog"
          onMouseEnter={enter}
          onMouseLeave={leave}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: W }}
          className="elevated fade-up fixed z-50 rounded-xl border border-line bg-surface p-3.5 text-left"
        >
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" /> {source.sourceName}
          </div>
          <div className="flex gap-3">
            <BookCover coverId={source.coverId} coverImage={source.coverImage} title={source.title} size="S" className="h-[60px] w-[40px] shrink-0" />
            <div className="min-w-0">
              <div className="font-serif text-[14.5px] font-semibold leading-snug">{source.title}</div>
              <dl className="mt-1 space-y-0.5 text-[12.5px] text-ink-2">
                <div>
                  <dt className="inline text-ink-3">Author: </dt>
                  <dd className="inline">{authors}</dd>
                </div>
                <div>
                  <dt className="inline text-ink-3">{source.releaseDate ? "Ebook released: " : "First published: "}</dt>
                  <dd className="inline">{source.releaseDate ?? published}</dd>
                </div>
                {source.editionCount ? (
                  <div>
                    <dt className="inline text-ink-3">Editions: </dt>
                    <dd className="inline">{source.editionCount}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </div>
          {source.description && <p className="mt-2 line-clamp-3 text-[12px] leading-snug text-ink-2">{source.description}</p>}
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2.5 inline-block text-[12.5px] font-medium text-accent hover:underline"
          >
            View source ↗
          </a>
        </div>,
          document.body,
        )}
    </>
  );
}
