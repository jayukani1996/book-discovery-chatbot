import type { BookSource } from "./types";
import { workUrl, type OLSearchHit, type OLWorkDetails } from "./openlibrary";
import { consistentPublishDate } from "./format";

/**
 * Conversation-scoped registry of every book record the agent has retrieved.
 * Ids are stable for the whole conversation ("S1", "S2", ...) and the same
 * Open Library work always maps to the same id, so a citation made three
 * turns ago still points at the same record.
 */
export class SourceRegistry {
  private byId = new Map<string, BookSource>();
  private byWork = new Map<string, string>();
  private next = 1;
  /** Ids added or updated during the current request (sent back to the client). */
  readonly touched = new Set<string>();

  constructor(initial: Record<string, BookSource> = {}) {
    for (let s of Object.values(initial)) {
      if (!isValidSource(s)) continue;
      // Client-held records are untrusted: rebuild the link and source name rather than trusting them.
      s = { ...s, url: workUrl(s.workKey), sourceName: "Open Library" };
      this.byId.set(s.id, s);
      this.byWork.set(s.workKey, s.id);
      const n = Number(s.id.slice(1));
      if (n >= this.next) this.next = n + 1;
    }
  }

  get(id: string): BookSource | undefined {
    return this.byId.get(id.trim().toUpperCase());
  }

  has(id: string) {
    return this.byId.has(id.trim().toUpperCase());
  }

  all(): BookSource[] {
    return [...this.byId.values()];
  }

  upsertFromSearch(hit: OLSearchHit): BookSource {
    const existingId = this.byWork.get(hit.workKey);
    const prev = existingId ? this.byId.get(existingId) : undefined;
    const id = existingId ?? `S${this.next++}`;
    const merged: BookSource = {
      ...prev,
      id,
      workKey: hit.workKey,
      title: hit.title,
      subtitle: hit.subtitle ?? prev?.subtitle,
      authors: hit.authors.length ? hit.authors : prev?.authors ?? [],
      authorKeys: hit.authorKeys.length ? hit.authorKeys : prev?.authorKeys ?? [],
      firstPublishYear: hit.firstPublishYear ?? prev?.firstPublishYear,
      coverId: hit.coverId ?? prev?.coverId,
      editionCount: hit.editionCount ?? prev?.editionCount,
      pageCount: hit.pageCount ?? prev?.pageCount,
      subjects: prev?.subjects?.length ? prev.subjects : hit.subjects,
      languages: hit.languages ?? prev?.languages,
      url: workUrl(hit.workKey),
      sourceName: "Open Library",
    };
    this.byId.set(id, merged);
    this.byWork.set(hit.workKey, id);
    this.touched.add(id);
    return merged;
  }

  applyDetails(id: string, d: OLWorkDetails): BookSource | undefined {
    const prev = this.get(id);
    if (!prev) return undefined;
    const merged: BookSource = {
      ...prev,
      description: d.description ?? prev.description,
      subjects: d.subjects?.length ? d.subjects : prev.subjects,
      firstPublishDate: d.firstPublishDate ?? prev.firstPublishDate,
      coverId: prev.coverId ?? d.coverId,
      detailsFetched: true,
    };
    this.byId.set(prev.id, merged);
    this.touched.add(prev.id);
    return merged;
  }

  touchedSources(): BookSource[] {
    return [...this.touched].map((id) => this.byId.get(id)!).filter(Boolean);
  }
}

function isValidSource(s: unknown): s is BookSource {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    /^S\d+$/.test(o.id) &&
    typeof o.workKey === "string" &&
    /^\/works\/OL\d+W$/.test(o.workKey) &&
    typeof o.title === "string" &&
    Array.isArray(o.authors)
  );
}

/** Compact, model-facing view of a record. Only facts that came from Open Library. */
export function sourceForModel(s: BookSource, opts: { full?: boolean } = {}) {
  return {
    id: s.id,
    title: s.subtitle ? `${s.title}: ${s.subtitle}` : s.title,
    authors: s.authors.length ? s.authors : undefined,
    first_publish_year: s.firstPublishYear,
    first_publish_date: s.firstPublishDate ? consistentPublishDate(s) : undefined,
    has_cover: !!s.coverId,
    edition_count: s.editionCount,
    median_pages: s.pageCount,
    subjects: s.subjects?.slice(0, opts.full ? 12 : 6),
    description: opts.full ? s.description : s.description ? truncate(s.description, 280) : undefined,
  };
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
}
