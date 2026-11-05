"use client";

import { useState } from "react";
import { coverUrl } from "@/lib/openlibrary";

const PALETTE = ["#7c2d12", "#1e3a5f", "#3f5f3a", "#5b3a6b", "#7a5a1e", "#2f4f4f"];

/** Cover image with a typographic fallback when the source has no cover (or it fails to load). */
export function BookCover({ coverId, coverImage, title, size = "M", className = "" }: { coverId?: number; coverImage?: string; title: string; size?: "S" | "M" | "L"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const url = coverImage ?? coverUrl(coverId, size);

  if (!url || failed) {
    const color = PALETTE[[...title].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
    if (size === "S") {
      return (
        <div
          className={`flex items-center justify-center rounded-[3px] font-serif text-lg text-white/85 shadow-sm ${className}`}
          style={{ background: color }}
          role="img"
          aria-label={`No cover available for ${title}`}
        >
          {title.trim()[0]?.toUpperCase()}
        </div>
      );
    }
    return (
      <div
        className={`flex flex-col justify-between overflow-hidden rounded-[3px] p-2 text-white/90 shadow-sm ${className}`}
        style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}
        aria-label={`No cover available for ${title}`}
        role="img"
      >
        <span className="line-clamp-4 font-serif text-[11px] leading-tight">{title}</span>
        <span className="text-[9px] uppercase tracking-wider text-white/60">No cover</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={`Cover of ${title}`}
      loading="lazy"
      onError={() => setFailed(true)}
      onLoad={(e) => {
        // OL returns a 1x1 placeholder for some missing covers.
        if ((e.currentTarget as HTMLImageElement).naturalWidth < 5) setFailed(true);
        else setLoaded(true);
      }}
      ref={(el) => {
        // Cached images can finish before React attaches onLoad.
        if (el?.complete && el.naturalWidth >= 5 && !loaded) setLoaded(true);
      }}
      className={`rounded-[3px] object-cover shadow-sm ring-1 ring-black/5 transition-opacity duration-300 dark:ring-white/10 ${loaded ? "bg-paper-2" : "shimmer"} ${className}`}
    />
  );
}
