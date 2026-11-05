import { beforeEach, describe, expect, it } from "vitest";
import { clearAppleBooksCache, looksNonEnglish, normalizeAppleBook, searchAppleBooks, topicWords } from "@/lib/applebooks";
import { clearOpenLibraryCache } from "@/lib/openlibrary";
import { SourceRegistry, sourceForModel } from "@/lib/sources";
import { executeTool, type ToolContext } from "@/lib/tools";
import { mockFetch, rowlingSearch } from "./fixtures";

const kindred = {
  trackId: 476024260,
  trackName: "Kindred",
  artistName: "Octavia Butler",
  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg",
  releaseDate: "1997-07-20T07:00:00Z",
  description: "<p>Dana is <b>transported</b> &amp; returns.</p>",
  genres: ["Fiction", "Books"],
};
const apple = (results: unknown[]) => ({ "itunes.apple.com": { resultCount: results.length, results } });

beforeEach(() => {
  clearAppleBooksCache();
  clearOpenLibraryCache();
});

describe("normalizeAppleBook", () => {
  it("keeps the release date apart from first publication and cleans the description", () => {
    const hit = normalizeAppleBook(kindred)!;
    expect(hit.workKey).toBe("/apple/476024260");
    expect(hit.releaseDate).toBe("1997-07-20");
    expect(hit.firstPublishYear).toBeUndefined();
    expect(hit.description).toBe("Dana is transported & returns.");
    expect(hit.coverImage).toContain("300x300");
    expect(hit.subjects).toEqual(["Fiction"]);
  });

  it("splits several authors and skips pre-orders", () => {
    expect(normalizeAppleBook({ ...kindred, artistName: "A One, B Two & C Three" })!.authors).toEqual(["A One", "B Two", "C Three"]);
    expect(normalizeAppleBook({ ...kindred, releaseDate: "2027-01-01T00:00:00Z" }, "2026-11-05")).toBeNull();
  });
});

describe("searchAppleBooks", () => {
  it("drops companion titles, other authors and duplicates", async () => {
    const r = await searchAppleBooks(
      { author: "Octavia E. Butler" },
      mockFetch(
        apple([
          kindred,
          { ...kindred, trackId: 2 },
          { ...kindred, trackId: 3, trackName: 'A Study Guide for "Kindred"' },
          { ...kindred, trackId: 7, trackName: "Kindred Notes", description: "This is a study guide to Kindred." },
          { ...kindred, trackId: 4, trackName: "Other Book", artistName: "Steven Smith" },
        ]),
      ),
    );
    expect(r.hits.map((h) => h.workKey)).toEqual(["/apple/476024260"]);
  });

  it("keeps topic searches on topic and retries with the bare topic", async () => {
    const terms: string[] = [];
    const r = await searchAppleBooks(
      { query: "introduction to startups", limit: 3 },
      mockFetch({
        "itunes.apple.com": (url: string) => {
          const term = new URL(url).searchParams.get("term")!;
          terms.push(term);
          const results =
            term === "startup"
              ? [{ ...kindred, trackId: 5, trackName: "Why Startups Fail", description: "About startups." }]
              : [{ ...kindred, trackId: 6, trackName: "Introduction to Swift", description: "A language." }];
          return new Response(JSON.stringify({ results }));
        },
      }),
    );
    expect(terms).toEqual(["introduction to startups", "startup"]);
    expect(r.hits.map((h) => h.title)).toEqual(["Why Startups Fail"]);
    expect(topicWords("Introductory books about Artificial Intelligence")).toEqual(["artificial", "intelligence"]);
  });

  it("recognises non-English descriptions", () => {
    expect(looksNonEnglish("Nouvelle traduction du chef-d'oeuvre. Le parti domine et la société.")).toBe(true);
    expect(looksNonEnglish("The story of a woman in the past and the present.")).toBe(false);
    expect(looksNonEnglish(undefined)).toBe(false);
  });

  it("retries once when Apple times out", async () => {
    let calls = 0;
    const f = (async () => {
      if (++calls === 1) throw new Error("timeout");
      return new Response(JSON.stringify({ results: [kindred] }));
    }) as unknown as typeof fetch;
    const r = await searchAppleBooks({ title: "Kindred" }, f);
    expect(calls).toBe(2);
    expect(r.hits).toHaveLength(1);
  });

  it("does not retry when Apple refuses", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("slow down", { status: 403 });
    }) as unknown as typeof fetch;
    await expect(searchAppleBooks({ title: "Kindred" }, f)).rejects.toThrow(/both unavailable/);
    expect(calls).toBe(1);
  });

  it("reports an outage when Apple fails too", async () => {
    await expect(searchAppleBooks({ query: "x" }, mockFetch({}))).rejects.toThrow(/both unavailable/);
  });
});

describe("source fallback", () => {
  const ctx = (fetchImpl: typeof fetch): ToolContext => ({ registry: new SourceRegistry(), fetchImpl, shownIds: null });
  const search = (c: ToolContext) => executeTool("search_books", JSON.stringify({ title: "Kindred" }), c) as Promise<{ results?: { source: string }[]; error?: string }>;

  it("uses Open Library when it answers, without calling Apple", async () => {
    let appleCalls = 0;
    const c = ctx(
      mockFetch({
        "search.json": rowlingSearch,
        "itunes.apple.com": () => {
          appleCalls++;
          return new Response("{}");
        },
      }),
    );
    const out = await search(c);
    expect(out.results?.[0].source).toBe("Open Library");
    expect(appleCalls).toBe(0);
  });

  it("switches to Apple Books when Open Library refuses, without reporting an outage", async () => {
    const c = ctx(mockFetch({ "search.json": () => new Response("down", { status: 503 }), ...apple([kindred]) }));
    const out = await search(c);
    expect(out.results?.[0].source).toBe("Apple Books");
    expect(c.sourceFailed).toBeFalsy();
    expect(c.registry.get("S1")?.url).toBe("https://books.apple.com/us/book/id476024260");

    const details = (await executeTool("get_book_details", JSON.stringify({ ids: ["S1"] }), c)) as { results: { description: string }[] };
    expect(details.results[0].description).toContain("Dana");
  });

  it("does not fall back on a search that simply found nothing", async () => {
    const c = ctx(mockFetch({ "search.json": { numFound: 0, docs: [] }, ...apple([kindred]) }));
    const out = await search(c);
    expect(out.results).toEqual([]);
  });

  it("reports an outage when both sources fail", async () => {
    const c = ctx(mockFetch({ "search.json": () => new Response("down", { status: 503 }) }));
    const out = await search(c);
    expect(out.error).toMatch(/unavailable/);
    expect(c.sourceFailed).toBe(true);
  });
});

describe("client-held Apple records", () => {
  it("are rebuilt on the server and never expose a first-publication claim", () => {
    const reg = new SourceRegistry({
      S1: {
        id: "S1",
        workKey: "/apple/476024260",
        title: "Kindred",
        authors: [],
        authorKeys: [],
        coverImage: "https://evil.example/x.png",
        releaseDate: "1997-07-20",
        url: "javascript:alert(1)",
        sourceName: "Open Library",
      },
    });
    const s = reg.get("S1")!;
    expect(s.url).toBe("https://books.apple.com/us/book/id476024260");
    expect(s.sourceName).toBe("Apple Books");
    expect(s.coverImage).toBeUndefined();
    const m = sourceForModel(s);
    expect(m.ebook_release_date).toBe("1997-07-20");
    expect(m.first_publish_year).toBeUndefined();
  });
});
