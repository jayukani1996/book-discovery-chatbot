/**
 * Thin Open Library client: search + work details + author details.
 * Docs: https://openlibrary.org/developers/api
 *
 * - Every request has a timeout and one retry on network/5xx failure.
 * - Responses are cached in memory for a few minutes (the data barely changes,
 *   and follow-up questions often re-request the same records).
 * - Output is normalized so the rest of the app never touches raw OL shapes.
 */

const BASE = "https://openlibrary.org";
const COVERS = "https://covers.openlibrary.org";
const USER_AGENT = "BookDiscoveryChat/1.0 (take-home prototype)";
const TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;

export class OpenLibraryError extends Error {}

const cache = new Map<string, { at: number; data: unknown }>();

async function getJson<T>(url: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (res.status === 404) throw new OpenLibraryError("Record not found on Open Library.");
      if (!res.ok) throw new Error(`Open Library responded with HTTP ${res.status}`);
      const data = (await res.json()) as T;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(url, { at: Date.now(), data });
      return data;
    } catch (err) {
      lastErr = err;
      if (err instanceof OpenLibraryError) throw err; // 404: don't retry
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastErr instanceof Error && lastErr.name === "AbortError" ? "request timed out" : String((lastErr as Error)?.message ?? lastErr);
  throw new OpenLibraryError(`Open Library is unavailable right now (${msg}).`);
}

/** Exposed for tests. */
export function clearOpenLibraryCache() {
  cache.clear();
}

// ---------- Normalized shapes ----------

export interface OLSearchHit {
  workKey: string;
  title: string;
  subtitle?: string;
  authors: string[];
  authorKeys: string[];
  firstPublishYear?: number;
  coverId?: number;
  editionCount?: number;
  pageCount?: number;
  subjects?: string[];
  languages?: string[];
}

export interface OLWorkDetails {
  workKey: string;
  title?: string;
  description?: string;
  subjects?: string[];
  firstPublishDate?: string;
  coverId?: number;
  authorKeys: string[];
}

export interface OLAuthorDetails {
  key: string;
  name?: string;
  birthDate?: string;
  deathDate?: string;
  bio?: string;
}

// ---------- Helpers ----------

export function coverUrl(coverId: number | undefined, size: "S" | "M" | "L" = "M") {
  return coverId && coverId > 0 ? `${COVERS}/b/id/${coverId}-${size}.jpg` : undefined;
}

export function workUrl(workKey: string) {
  return `${BASE}${workKey.startsWith("/") ? "" : "/"}${workKey}`;
}

/** OL text fields are either strings or { type, value } objects. */
function textValue(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in v && typeof (v as { value: unknown }).value === "string") {
    return (v as { value: string }).value;
  }
  return undefined;
}

/** Strip OL markdown-ish noise ("----------", source footers, link syntax) and cap length. */
export function cleanDescription(raw: string | undefined, max = 1200): string | undefined {
  if (!raw) return undefined;
  let s = raw.split(/\r?\n-{5,}/)[0]; // drop "Also contained in" footers
  s = s.replace(/\[([^\]]+)\]\[\d+\]/g, "$1"); // [text][1]
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1"); // [text](url)
  s = s.replace(/^\s*\[\d+\]:\s*\S+.*$/gm, ""); // reference link defs
  s = s.replace(/\(\[source\]\[\d+\]\)/gi, "");
  s = s.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, "") + "…" : s;
}

const SEARCH_FIELDS = [
  "key",
  "title",
  "subtitle",
  "author_name",
  "author_key",
  "first_publish_year",
  "cover_i",
  "edition_count",
  "number_of_pages_median",
  "subject",
  "language",
].join(",");

export interface SearchParams {
  query?: string;
  title?: string;
  author?: string;
  subject?: string;
  sort?: "relevance" | "editions" | "new" | "old";
  limit?: number;
  onlyWithCovers?: boolean;
  language?: string; // ISO 639-2, e.g. "eng"
}

interface RawSearchDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  author_key?: string[];
  first_publish_year?: number;
  cover_i?: number;
  edition_count?: number;
  number_of_pages_median?: number;
  subject?: string[];
  language?: string[];
}

export function normalizeSearchDoc(d: RawSearchDoc): OLSearchHit | null {
  if (!d.key || !d.title) return null;
  return {
    workKey: d.key,
    title: d.title,
    subtitle: d.subtitle || undefined,
    authors: d.author_name ?? [],
    authorKeys: (d.author_key ?? []).map((k) => (k.startsWith("/") ? k : `/authors/${k}`)),
    firstPublishYear: d.first_publish_year,
    coverId: d.cover_i && d.cover_i > 0 ? d.cover_i : undefined,
    editionCount: d.edition_count,
    pageCount: d.number_of_pages_median,
    subjects: d.subject?.slice(0, 10),
    languages: d.language?.slice(0, 5),
  };
}

export async function searchBooks(p: SearchParams, fetchImpl?: typeof fetch): Promise<{ total: number; hits: OLSearchHit[] }> {
  const limit = Math.min(Math.max(p.limit ?? 8, 1), 20);
  const qs = new URLSearchParams();
  if (p.query) qs.set("q", p.query);
  if (p.title) qs.set("title", p.title);
  if (p.author) qs.set("author", p.author);
  if (p.subject) qs.set("subject", p.subject);
  if (p.language) qs.set("language", p.language);
  if (![...qs.keys()].length) throw new OpenLibraryError("A search needs at least a query, title, author or subject.");
  if (p.sort && p.sort !== "relevance") qs.set("sort", p.sort);
  // Over-fetch when filtering client-side so we can still return `limit` results.
  qs.set("limit", String(p.onlyWithCovers ? Math.min(limit * 3, 60) : limit));
  qs.set("fields", SEARCH_FIELDS);

  const data = await getJson<{ numFound?: number; docs?: RawSearchDoc[] }>(`${BASE}/search.json?${qs}`, fetchImpl);
  let hits = (data.docs ?? []).map(normalizeSearchDoc).filter((h): h is OLSearchHit => h !== null);
  if (p.onlyWithCovers) hits = hits.filter((h) => h.coverId);
  return { total: data.numFound ?? hits.length, hits: hits.slice(0, limit) };
}

export async function getWork(workKey: string, fetchImpl?: typeof fetch): Promise<OLWorkDetails> {
  const key = workKey.startsWith("/works/") ? workKey : `/works/${workKey.replace(/^\//, "")}`;
  const raw = await getJson<{
    title?: string;
    description?: unknown;
    subjects?: string[];
    first_publish_date?: string;
    covers?: number[];
    authors?: { author?: { key?: string } }[];
  }>(`${BASE}${key}.json`, fetchImpl);
  return {
    workKey: key,
    title: raw.title,
    description: cleanDescription(textValue(raw.description)),
    subjects: raw.subjects?.slice(0, 12),
    firstPublishDate: raw.first_publish_date,
    coverId: raw.covers?.find((c) => c > 0),
    authorKeys: (raw.authors ?? []).map((a) => a.author?.key).filter((k): k is string => !!k),
  };
}

export async function getAuthor(authorKey: string, fetchImpl?: typeof fetch): Promise<OLAuthorDetails> {
  const key = authorKey.startsWith("/authors/") ? authorKey : `/authors/${authorKey.replace(/^\//, "")}`;
  const raw = await getJson<{ name?: string; birth_date?: string; death_date?: string; bio?: unknown }>(`${BASE}${key}.json`, fetchImpl);
  return {
    key,
    name: raw.name,
    birthDate: raw.birth_date,
    deathDate: raw.death_date,
    bio: cleanDescription(textValue(raw.bio), 600),
  };
}
