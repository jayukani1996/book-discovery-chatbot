/** Hand-written fixtures in the shape of real Open Library responses. */

export const rowlingSearch = {
  numFound: 412,
  docs: [
    {
      key: "/works/OL82563W",
      title: "Harry Potter and the Philosopher's Stone",
      author_name: ["J. K. Rowling"],
      author_key: ["OL23919A"],
      first_publish_year: 1997,
      cover_i: 10521270,
      edition_count: 391,
      subject: ["Wizards", "Magic", "Schools", "Fiction"],
    },
    {
      key: "/works/OL82537W",
      title: "Harry Potter and the Chamber of Secrets",
      author_name: ["J. K. Rowling"],
      author_key: ["OL23919A"],
      first_publish_year: 1998,
      cover_i: 8234423,
      edition_count: 280,
    },
    {
      key: "/works/OL17360763W",
      title: "The Casual Vacancy",
      author_name: ["J. K. Rowling"],
      author_key: ["OL23919A"],
      first_publish_year: 2012,
      edition_count: 64,
    },
    { key: "/works/BROKEN" }, // missing title -> dropped
  ],
};

export const kindredSearch = {
  numFound: 3,
  docs: [
    {
      key: "/works/OL1914022W",
      title: "Kindred",
      author_name: ["Octavia E. Butler"],
      author_key: ["OL24529A"],
      first_publish_year: 1979,
      cover_i: 8306866,
      edition_count: 61,
    },
  ],
};

export const kindredWork = {
  title: "Kindred",
  description: {
    type: "/type/text",
    value:
      "Dana, a modern black woman, is celebrating her twenty-sixth birthday with her new husband when she is snatched abruptly from her home in California and transported to the antebellum South.\r\n\r\n----------\r\nAlso contained in:\r\n[Kindred / Wild Seed](https://openlibrary.org/works/OL1W)",
  },
  subjects: ["Time travel", "Slavery", "Fiction"],
  first_publish_date: "1979",
  covers: [8306866],
  authors: [{ author: { key: "/authors/OL24529A" } }],
};

export function mockFetch(routes: Record<string, unknown | ((url: string) => Response)>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) {
        if (typeof body === "function") return (body as (u: string) => Response)(url);
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
