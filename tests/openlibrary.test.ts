import { beforeEach, describe, expect, it } from "vitest";
import { cleanDescription, clearOpenLibraryCache, coverUrl, getWork, searchBooks } from "@/lib/openlibrary";
import { kindredWork, mockFetch, rowlingSearch } from "./fixtures";

beforeEach(() => clearOpenLibraryCache());

describe("request pacing", () => {
  it("spaces parallel requests out and doesn't delay cached ones", async () => {
    const sent: number[] = [];
    const f = mockFetch({
      "search.json": () => {
        sent.push(Date.now());
        return new Response(JSON.stringify(rowlingSearch));
      },
    });
    await Promise.all(["a", "b", "c"].map((author) => searchBooks({ author }, f)));
    expect(sent).toHaveLength(3);
    expect(sent[2] - sent[0]).toBeGreaterThanOrEqual(650);

    const t0 = Date.now();
    await searchBooks({ author: "a" }, f);
    expect(sent).toHaveLength(3);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe("cooldown after a refusal", () => {
  it("stops calling Open Library for a while once it refuses", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(searchBooks({ author: "a" }, f)).rejects.toThrow(/unavailable/);
    const afterFirst = calls;
    await expect(searchBooks({ author: "b" }, f)).rejects.toThrow(/unavailable/);
    expect(calls).toBe(afterFirst);
  });
});

describe("searchBooks", () => {
  it("builds the query and normalizes docs (dropping malformed ones)", async () => {
    let seen = "";
    const f = mockFetch({
      "search.json": (url: string) => {
        seen = url;
        return new Response(JSON.stringify(rowlingSearch));
      },
    });
    const r = await searchBooks({ author: "J.K. Rowling", sort: "editions", limit: 5 }, f);
    expect(seen).toContain("author=J.K.+Rowling");
    expect(seen).toContain("sort=editions");
    expect(r.total).toBe(412);
    expect(r.hits).toHaveLength(3);
    expect(r.hits[0]).toMatchObject({
      workKey: "/works/OL82563W",
      authors: ["J. K. Rowling"],
      authorKeys: ["/authors/OL23919A"],
      firstPublishYear: 1997,
      coverId: 10521270,
    });
  });

  it("filters to books with covers", async () => {
    const r = await searchBooks({ author: "Rowling", onlyWithCovers: true }, mockFetch({ "search.json": rowlingSearch }));
    expect(r.hits.every((h) => h.coverId)).toBe(true);
    expect(r.hits.map((h) => h.title)).not.toContain("The Casual Vacancy");
  });

  it("searches a title on its own as plain text, without a sort", async () => {
    let seen = "";
    const f = mockFetch({
      "search.json": (url: string) => {
        seen = url;
        return new Response(JSON.stringify({ numFound: 0, docs: [] }));
      },
    });
    await searchBooks({ title: "1984", sort: "editions" }, f);
    expect(seen).toContain("q=1984");
    expect(seen).not.toContain("title=");
    expect(seen).not.toContain("sort=");
  });

  it("rejects empty searches", async () => {
    await expect(searchBooks({}, mockFetch({}))).rejects.toThrow(/at least/);
  });

  it("reports a friendly error when Open Library is down", async () => {
    const f = mockFetch({ "search.json": () => new Response("oops", { status: 503 }) });
    await expect(searchBooks({ query: "x" }, f)).rejects.toThrow(/unavailable/);
  });
});

describe("getWork / helpers", () => {
  it("reads {type,value} descriptions and strips OL footers and links", async () => {
    const w = await getWork("/works/OL1914022W", mockFetch({ "/works/OL1914022W.json": kindredWork }));
    expect(w.description).toMatch(/^Dana, a modern black woman/);
    expect(w.description).not.toContain("Also contained");
    expect(w.firstPublishDate).toBe("1979");
    expect(w.authorKeys).toEqual(["/authors/OL24529A"]);
  });

  it("cleans markdown links and truncates", () => {
    expect(cleanDescription("Read [the book](https://a.b) now")).toBe("Read the book now");
    expect(cleanDescription("word ".repeat(400), 50)!.length).toBeLessThanOrEqual(51);
    expect(cleanDescription("   ")).toBeUndefined();
  });

  it("builds cover urls only for real cover ids", () => {
    expect(coverUrl(123, "M")).toBe("https://covers.openlibrary.org/b/id/123-M.jpg");
    expect(coverUrl(undefined)).toBeUndefined();
    expect(coverUrl(-1)).toBeUndefined();
  });
});

describe("Open Library anti-bot handling", () => {
  it("reports a verify_human redirect clearly and doesn't retry", async () => {
    clearOpenLibraryCache();
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(null, { status: 303, headers: { location: "https://openlibrary.org/verify_human?next=/search.json" } });
    }) as unknown as typeof fetch;
    await expect(searchBooks({ query: "dune" }, f)).rejects.toThrow(/temporarily limiting/);
    expect(calls).toBe(1);
  });

  it("follows ordinary redirects within Open Library (merged works)", async () => {
    const f = (async (u: string) =>
      u.includes("OL1W")
        ? new Response(null, { status: 301, headers: { location: "/works/OL2W.json" } })
        : new Response(JSON.stringify({ title: "Merged", authors: [] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(getWork("/works/OL1W", f)).resolves.toMatchObject({ title: "Merged" });
  });

  it("refuses to follow a redirect to another site", async () => {
    const f = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.json" } })) as unknown as typeof fetch;
    await expect(getWork("/works/OL1W", f)).rejects.toThrow(/unavailable right now/);
  });

  it("treats an HTML page as unavailable rather than crashing on JSON parsing", async () => {
    clearOpenLibraryCache();
    const f = (async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(searchBooks({ query: "dune" }, f)).rejects.toThrow(/unavailable right now \(non-JSON response\)/);
  });
});
