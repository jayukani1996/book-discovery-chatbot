/**
 * Backup book source, used only when Open Library refuses or can't be reached.
 * Docs: https://performance-partners.apple.com/search-api
 *
 * Apple's catalog lists ebooks, so a record's date is that ebook's release date and
 * not the book's first publication. Records keep the two apart (`releaseDate` vs
 * `firstPublishYear`), and the app and the model must never present one as the other.
 */
import { cleanDescription, OpenLibraryUnavailableError, type OLSearchHit, type SearchParams } from "./openlibrary";

const SEARCH_URL = "https://itunes.apple.com/search";
const TIMEOUT_MS = 7000;
const RETRY_DELAY_MS = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const UNAVAILABLE = "Open Library and Apple Books are both unavailable right now.";

export const APPLE_KEY_RE = /^\/apple\/\d+$/;
const COVER_RE = /^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//i;
// Companion titles rather than the book itself.
const COMPANION_RE = /\b(study guide|summary (of|and|&)|summary:|analysis of|sparknotes|supersummary|cliffsnotes|book summary|chapter[- ]by[- ]chapter summary)\b/i;

export function appleUrl(workKey: string) {
  return `https://books.apple.com/us/book/id${workKey.replace("/apple/", "")}`;
}

/** Only Apple's image host is trusted, because client-held records come back to the server. */
export function safeCoverImage(url: unknown): string | undefined {
  return typeof url === "string" && COVER_RE.test(url) ? url : undefined;
}

interface RawAppleBook {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  artworkUrl100?: string;
  releaseDate?: string;
  description?: string;
  genres?: string[];
}

const cache = new Map<string, { at: number; hits: RawAppleBook[] }>();

export function clearAppleBooksCache() {
  cache.clear();
}

function plainText(html: string | undefined) {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
  return cleanDescription(text);
}

export function normalizeAppleBook(b: RawAppleBook, today = new Date().toISOString().slice(0, 10)): OLSearchHit | null {
  if (!b.trackId || !b.trackName) return null;
  const release = b.releaseDate?.slice(0, 10);
  if (release && release > today) return null; // pre-orders aren't out yet
  return {
    workKey: `/apple/${b.trackId}`,
    title: b.trackName,
    authors: (b.artistName ?? "").split(/\s*(?:,|&)\s*/).filter(Boolean),
    authorKeys: [],
    coverImage: safeCoverImage(b.artworkUrl100?.replace("100x100", "300x300")),
    releaseDate: release,
    description: plainText(b.description),
    subjects: b.genres?.filter((g) => g !== "Books").slice(0, 10),
    sourceName: "Apple Books",
  };
}

const lastName = (name: string) => name.trim().toLowerCase().split(/\s+/).pop() ?? "";

async function fetchRaw(term: string, attribute: string | undefined, fetchImpl: typeof fetch): Promise<RawAppleBook[]> {
  const qs = new URLSearchParams({ term, media: "ebook", entity: "ebook", country: "us", limit: "50" });
  if (attribute) qs.set("attribute", attribute);
  const url = `${SEARCH_URL}?${qs}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.hits;

  let data: { results?: RawAppleBook[] } | null = null;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) break; // a refusal: asking again straight away only makes it worse
      data = (await res.json()) as { results?: RawAppleBook[] };
    } catch {
      // timed out or unreadable: try once more
    }
  }
  if (!data) throw new OpenLibraryUnavailableError(UNAVAILABLE);
  const hits = data.results ?? [];
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(url, { at: Date.now(), hits });
  return hits;
}

const FILLER = new Set(["introduction", "introductory", "intro", "to", "for", "beginner", "beginners", "book", "books", "about", "the", "a", "an", "of", "on", "guide"]);
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** The words that say what a topic search is about, so "introduction to startups" can match on "startup". */
export const topicWords = (q: string) => words(q).filter((w) => !FILLER.has(w)).map((w) => w.replace(/s$/, ""));

const ENGLISH = new Set(["the", "of", "and", "to", "in", "is", "with", "for"]);
const FOREIGN = new Set(["le", "la", "les", "des", "du", "et", "une", "el", "los", "las", "una", "que", "der", "die", "das", "und", "il", "di", "della"]);
/** Apple doesn't give a language, and non-English editions of well-known books rank highly. */
export function looksNonEnglish(text: string | undefined) {
  const all = words(text ?? "");
  return all.filter((w) => FOREIGN.has(w)).length > all.filter((w) => ENGLISH.has(w)).length;
}

export async function searchAppleBooks(p: SearchParams, fetchImpl: typeof fetch = fetch): Promise<{ total: number; hits: OLSearchHit[] }> {
  const limit = Math.min(Math.max(p.limit ?? 8, 1), 20);
  const topic = p.query ?? p.subject;
  const term = [p.title, p.author, topic].filter(Boolean).join(" ");
  const attribute = p.author && !p.title && !topic ? "authorTerm" : p.title && !p.author && !topic ? "titleTerm" : undefined;
  const wanted = topic && !p.title && !p.author ? topicWords(topic) : [];

  const seen = new Set<string>();
  const clean = (raw: RawAppleBook[]) =>
    raw
      .map((b) => normalizeAppleBook(b))
      .filter((h): h is OLSearchHit => h !== null)
      .filter((h) => !COMPANION_RE.test(`${h.title} ${h.authors.join(" ")} ${h.description?.slice(0, 300) ?? ""}`))
      .filter((h) => !looksNonEnglish(h.description))
      .filter((h) => !p.author || h.authors.some((a) => a.toLowerCase().includes(lastName(p.author!))))
      // Apple matches any word of a phrase: keep books that are really about the topic.
      .filter((h) => !wanted.length || wanted.some((w) => `${h.title} ${h.description ?? ""}`.toLowerCase().includes(w)))
      .filter((h) => {
        const k = `${h.title.toLowerCase()}|${h.authors[0]?.toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

  const inTitle = (h: OLSearchHit) => wanted.some((w) => h.title.toLowerCase().includes(w));
  let hits = clean(await fetchRaw(term, attribute, fetchImpl));
  // A phrase such as "introduction to startups" can match little; the bare topic does better.
  const bare = wanted.join(" ");
  if (hits.filter(inTitle).length < 3 && bare && bare !== term.toLowerCase()) hits = [...hits, ...clean(await fetchRaw(bare, undefined, fetchImpl))];
  if (wanted.length) hits = [...hits.filter(inTitle), ...hits.filter((h) => !inTitle(h))];

  if (p.onlyWithCovers) hits = hits.filter((h) => h.coverImage);
  if (p.sort === "new") hits = [...hits].sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
  if (p.sort === "old") hits = [...hits].sort((a, b) => (a.releaseDate ?? "9").localeCompare(b.releaseDate ?? "9"));
  return { total: hits.length, hits: hits.slice(0, limit) };
}
