/**
 * Thin Open Library client: search + work details + author details.
 * Docs: https://openlibrary.org/developers/api
 *
 * - Every request has a timeout and one retry on network/5xx failure.
 * - Requests are paced, because bursts get an IP refused by Open Library.
 * - Responses are cached in memory for a few minutes (the data barely changes,
 *   and follow-up questions often re-request the same records).
 * - Output is normalized so the rest of the app never touches raw OL shapes.
 */

const BASE = "https://openlibrary.org";
const COVERS = "https://covers.openlibrary.org";
// Open Library asks API clients to identify themselves with an app name and a contact
// (https://openlibrary.org/developers/api). Set OPENLIBRARY_CONTACT to an email or URL.
const USER_AGENT = `ShelfBookChat/1.0 (${process.env.OPENLIBRARY_CONTACT || "take-home prototype"})`;
const TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;
const RETRY_DELAY_MS = 600;
const MIN_GAP_MS = 350; // about three requests a second, per server instance

export class OpenLibraryError extends Error {}
/** Open Library itself couldn't be reached or is limiting us (as opposed to a bad request or a missing record). */
export class OpenLibraryUnavailableError extends OpenLibraryError {}

const cache = new Map<string, { at: number; data: unknown }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextSlot = 0;
/** Hands out evenly spaced send times, so parallel tool calls can't burst. */
async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

async function getJson<T>(url: string, fetchImpl: typeof fetch = fetch, hops = 0): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS); // back off instead of hammering a struggling API
    await waitForSlot();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: ctrl.signal,
        redirect: "manual",
      });
      if (res.status === 404) throw new OpenLibraryError("Record not found on Open Library.");
      // Open Library's anti-bot / rate-limit responses: a redirect to its "verify human" page, or 429.
      const location = res.headers.get("location") ?? "";
      if (res.status === 429 || /verify_human/.test(location)) {
        throw new OpenLibraryUnavailableError("Open Library is temporarily limiting requests (anti-bot check). Please try again in a minute.");
      }
      if (res.status >= 300 && res.status < 400) {
        // Ordinary redirects (e.g. merged works) are followed, but only within Open Library.
        const next = location ? new URL(location, url) : null;
        if (!next || next.origin !== BASE || hops >= 3) throw new Error("unexpected redirect");
        return await getJson<T>(next.href, fetchImpl, hops + 1);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new Error("non-JSON response");
      const data = (await res.json()) as T;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(url, { at: Date.now(), data });
      return data;
    } catch (err) {
      lastErr = err;
      if (err instanceof OpenLibraryError) throw err; // 404 / rate-limited: retrying won't help
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastErr instanceof Error && lastErr.name === "AbortError" ? "request timed out" : String((lastErr as Error)?.message ?? lastErr);
  throw new OpenLibraryUnavailableError(`Open Library is unavailable right now (${msg}).`);
}

/** Exposed for tests. */
export function clearOpenLibraryCache() {
  cache.clear();
  nextSlot = 0;
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
