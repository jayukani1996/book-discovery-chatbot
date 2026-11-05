import { beforeEach, describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { buildMessages, runAgent, friendlyError } from "@/lib/agent";
import { clearOpenLibraryCache } from "@/lib/openlibrary";
import { SourceRegistry } from "@/lib/sources";
import type { BookSource, ChatRequestBody, StreamEvent } from "@/lib/types";
import { kindredSearch, kindredWork, mockFetch, rowlingSearch } from "./fixtures";

beforeEach(() => clearOpenLibraryCache());

type Step = { text?: string; calls?: { name: string; args: unknown }[] };

/** Fake OpenAI client that streams a scripted sequence of model turns and records requests. */
function fakeOpenAI(steps: Step[]) {
  const requests: { messages: unknown[]; tool_choice?: unknown }[] = [];
  let i = 0;
  const client = {
    chat: {
      completions: {
        create: async (body: { messages: unknown[]; tool_choice?: unknown }) => {
          requests.push(JSON.parse(JSON.stringify(body)));
          const step = steps[i++] ?? { text: "" };
          async function* gen() {
            if (step.text) for (const piece of step.text.match(/.{1,12}/gs) ?? []) yield { choices: [{ delta: { content: piece } }] };
            for (const [idx, c] of (step.calls ?? []).entries()) {
              const args = JSON.stringify(c.args);
              yield { choices: [{ delta: { tool_calls: [{ index: idx, id: `call_${i}_${idx}`, function: { name: c.name, arguments: args.slice(0, 5) } }] } }] };
              yield { choices: [{ delta: { tool_calls: [{ index: idx, function: { arguments: args.slice(5) } }] } }] };
            }
          }
          return gen();
        },
      },
    },
  };
  return { client: client as unknown as OpenAI, requests };
}

async function run(steps: Step[], body: ChatRequestBody, fetchImpl: typeof fetch) {
  const { client, requests } = fakeOpenAI(steps);
  const events: StreamEvent[] = [];
  await runAgent({ openai: client, model: "test", body, emit: (e) => events.push(e), fetchImpl });
  const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  const sources = Object.fromEntries(events.flatMap((e) => (e.type === "sources" ? e.sources : [])).map((s) => [s.id, s]));
  const books = (events.filter((e) => e.type === "books").pop() as { ids: string[] } | undefined)?.ids;
  return { events, text, sources, books, requests };
}

const user = (content: string) => ({ role: "user" as const, content });

describe("runAgent", () => {
  it("search by author: runs the tool, streams cited text and shows cards", async () => {
    const r = await run(
      [
        { calls: [{ name: "search_books", args: { author: "J.K. Rowling", sort: "editions" } }] },
        { calls: [{ name: "show_books", args: { ids: ["S1", "S2", "S3", "S42"] } }] },
        { text: "Here are books by J. K. Rowling [S1]. The first was published in 1997 [S1]." },
      ],
      { messages: [user("Find books by J.K. Rowling.")], sources: {} },
      mockFetch({ "search.json": rowlingSearch }),
    );
    expect(r.events.find((e) => e.type === "status")).toMatchObject({ message: expect.stringContaining("books by J.K. Rowling") });
    expect(Object.keys(r.sources)).toEqual(["S1", "S2", "S3"]);
    expect(r.sources.S1.url).toBe("https://openlibrary.org/works/OL82563W");
    expect(r.books).toEqual(["S1", "S2", "S3"]); // unknown S42 ignored
    expect(r.text).toContain("[S1]");
    // the tool result fed back to the model contains only Open Library data
    const toolMsg = (r.requests[1].messages as { role: string; content: string }[]).find((m) => m.role === "tool")!;
    expect(JSON.parse(toolMsg.content).results[0]).toMatchObject({ id: "S1", first_publish_year: 1997, has_cover: true });
  });

  it("follow-up: previous results keep their ids and the model sees what was displayed", async () => {
    const prior = new SourceRegistry();
    for (const d of rowlingSearch.docs.slice(0, 3)) {
      prior.upsertFromSearch({
        workKey: d.key,
        title: d.title!,
        authors: d.author_name!,
        authorKeys: [],
        firstPublishYear: d.first_publish_year,
        coverId: d.cover_i,
      });
    }
    const sources = Object.fromEntries(prior.all().map((s) => [s.id, s])) as Record<string, BookSource>;
    const body: ChatRequestBody = {
      messages: [
        user("Find books by J.K. Rowling."),
        { role: "assistant", content: "Here are some [S1].", bookIds: ["S1", "S2", "S3"] },
        user("Tell me more about the second result."),
      ],
      sources,
    };
    const msgs = buildMessages(body, new SourceRegistry(sources));
    const assistant = msgs.find((m) => m.role === "system" && String(m.content).startsWith("App note")) as { content: string };
    expect(assistant.content).toContain('2. S2 "Harry Potter and the Chamber of Secrets"');
    expect(assistant.content).toContain("cover: no"); // The Casual Vacancy (supports the cover filter)

    const r = await run(
      [
        { calls: [{ name: "get_book_details", args: { ids: ["S2"] } }] },
        { text: "Chamber of Secrets was first published in 1998 [S2]." },
      ],
      body,
      mockFetch({ "/works/OL82537W.json": { title: "x", subjects: ["Magic"], first_publish_date: "1998" } }),
    );
    expect(r.sources.S2.detailsFetched).toBe(true);
    expect(r.sources.S2.firstPublishDate).toBe("1998");
  });

  it("new search results continue the id sequence and dedupe by work", async () => {
    const r = await run(
      [{ calls: [{ name: "search_books", args: { title: "Kindred" } }] }, { text: "Kindred [S4]" }],
      {
        messages: [user("Who wrote Kindred?")],
        sources: {
          S3: { id: "S3", workKey: "/works/OL1W", title: "Old", authors: [], authorKeys: [], url: "javascript:alert(1)", sourceName: "Open Library" },
        },
      },
      mockFetch({ "search.json": kindredSearch, "/works/OL1914022W.json": kindredWork }),
    );
    expect(Object.keys(r.sources)).toEqual(["S4"]);
  });

  it("never trusts a client-supplied link for a stored record", () => {
    const reg = new SourceRegistry({
      S1: { id: "S1", workKey: "/works/OL1W", title: "T", authors: [], authorKeys: [], url: "javascript:alert(1)", sourceName: "Open Library" },
      S2: { id: "S2", workKey: "javascript:x", title: "T", authors: [], authorKeys: [], url: "x", sourceName: "Open Library" },
    } as never);
    expect(reg.get("S1")?.url).toBe("https://openlibrary.org/works/OL1W");
    expect(reg.has("S2")).toBe(false);
  });

  it("tells the model when Open Library fails instead of throwing", async () => {
    const r = await run(
      [{ calls: [{ name: "search_books", args: { query: "startups" } }] }, { text: "I couldn't reach Open Library right now." }],
      { messages: [user("Recommend startup books")], sources: {} },
      mockFetch({ "search.json": () => new Response("down", { status: 503 }) }),
    );
    const toolMsg = (r.requests[1].messages as { role: string; content: string }[]).find((m) => m.role === "tool")!;
    expect(JSON.parse(toolMsg.content).error).toMatch(/unavailable/);
    expect(r.text).toContain("couldn't reach");
  });

  it("stops when the answer text and show_books arrive in the same turn (no duplicate answer)", async () => {
    const r = await run(
      [
        { calls: [{ name: "search_books", args: { author: "Rowling" } }] },
        { text: "Here they are [S1].", calls: [{ name: "show_books", args: { ids: ["S1"] } }] },
        { text: "DUPLICATE" },
      ],
      { messages: [user("Rowling books")], sources: {} },
      mockFetch({ "search.json": rowlingSearch }),
    );
    expect(r.text).toBe("Here they are [S1].");
    expect(r.books).toEqual(["S1"]);
  });

  it("forces a final answer after too many tool rounds", async () => {
    const loop = Array.from({ length: 5 }, () => ({ calls: [{ name: "search_books", args: { query: "ai" } }] }));
    const r = await run([...loop, { text: "Done." }], { messages: [user("ai books")], sources: {} }, mockFetch({ "search.json": rowlingSearch }));
    expect(r.requests.at(-1)!.tool_choice).toBe("none");
    expect(r.text).toBe("Done.");
  });
});

describe("friendlyError", () => {
  it("maps provider errors to actionable messages", () => {
    expect(friendlyError({ status: 401 })).toMatch(/API key/);
    expect(friendlyError({ status: 429 })).toMatch(/rate-limited/);
    expect(friendlyError({ status: 404 })).toMatch(/OPENAI_MODEL/);
  });
});

describe("guardrails", () => {
  it("replaces an improvised answer with the error card when Open Library is down", async () => {
    const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const r = await run(
      [{ calls: [{ name: "search_books", args: { title: "Kindred" } }] }, { text: "Sorry, I can't reach the catalog." }],
      { messages: [user("Who wrote Kindred?")], sources: {} },
      down,
    );
    const reset = r.events.filter((e) => e.type === "reset").pop() as { content: string };
    expect(reset.content).toBe("");
    expect(r.events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("couldn't reach Open Library") });
    expect(r.books).toBeUndefined();
  });

  it("re-shows the covered books if the model forgets the cards on a cover filter", async () => {
    const reg = new SourceRegistry();
    for (const d of rowlingSearch.docs.slice(0, 3)) {
      reg.upsertFromSearch({ workKey: d.key, title: d.title!, authors: d.author_name!, authorKeys: [], coverId: d.cover_i });
    }
    const sources = Object.fromEntries(reg.all().map((s) => [s.id, s]));
    const r = await run(
      [{ text: "All of those already have cover images." }],
      {
        messages: [
          user("Find books by J.K. Rowling."),
          { role: "assistant", content: "Here are some.", bookIds: ["S1", "S2", "S3"] },
          user("Only show me books with cover images."),
        ],
        sources,
      },
      mockFetch({}),
    );
    const expected = reg.all().filter((s) => s.coverId).map((s) => s.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(r.books).toEqual(expected);
  });

  it("a search with no terms is not mistaken for an outage", async () => {
    const r = await run(
      [{ calls: [{ name: "search_books", args: {} }] }, { text: "I don't have a results list yet. What should I search for?" }],
      { messages: [user("Find me something.")], sources: {} },
      mockFetch({}),
    );
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(r.text).toContain("What should I search for?");
  });

  it("keeps an answer citing real records even if a later lookup failed", async () => {
    let n = 0;
    const flaky = (async (u: string) => {
      if (String(u).includes("search.json") && n++ === 0) return new Response(JSON.stringify(kindredSearch), { status: 200 });
      return new Response("down", { status: 503 });
    }) as unknown as typeof fetch;
    const r = await run(
      [
        { calls: [{ name: "search_books", args: { title: "Kindred" } }] },
        { calls: [{ name: "get_book_details", args: { ids: ["S1"] } }] },
        { text: "Kindred was written by Octavia E. Butler [S1]." },
      ],
      { messages: [user("Who wrote Kindred?")], sources: {} },
      flaky,
    );
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(r.text).toContain("Octavia E. Butler");
  });

  it("discards a preamble written before more tool calls (no duplicated answer)", async () => {
    const r = await run(
      [
        { text: "Kindred was written by someone.", calls: [{ name: "search_books", args: { title: "Kindred" } }] },
        { text: "Kindred was written by Octavia E. Butler [S1]." },
      ],
      { messages: [user("Who wrote Kindred?")], sources: {} },
      mockFetch({ "search.json": kindredSearch, "works/": kindredWork }),
    );
    const resetAt = r.events.findIndex((e) => e.type === "reset");
    expect(resetAt).toBeGreaterThan(-1);
    const finalText = r.events
      .slice(resetAt + 1)
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(finalText).toBe("Kindred was written by Octavia E. Butler [S1].");
  });

  it("falls back to cards for cited records when show_books is never called", async () => {
    const r = await run(
      [{ calls: [{ name: "search_books", args: { title: "Kindred" } }] }, { text: "Kindred was written by Octavia E. Butler [S1]." }],
      { messages: [user("Who wrote Kindred?")], sources: {} },
      mockFetch({ "search.json": kindredSearch }),
    );
    expect(r.books).toEqual(["S1"]);
  });

  it("shows cards for cited records when show_books is called with nothing", async () => {
    const r = await run(
      [
        { calls: [{ name: "search_books", args: { title: "Kindred" } }] },
        { text: "Kindred was written by Octavia E. Butler [S1].", calls: [{ name: "show_books", args: { ids: [] } }] },
      ],
      { messages: [user("Who wrote Kindred?")], sources: {} },
      mockFetch({ "search.json": kindredSearch }),
    );
    expect(r.books).toEqual(["S1"]);
  });

  it("shows the cited books when the cards and the text are about different books", async () => {
    const r = await run(
      [
        { calls: [{ name: "search_books", args: { author: "J.K. Rowling" } }] },
        { text: "More: Chamber of Secrets [S2].", calls: [{ name: "show_books", args: { ids: ["S1"] } }] },
      ],
      { messages: [user("Show me more.")], sources: {} },
      mockFetch({ "search.json": rowlingSearch }),
    );
    expect(r.books).toEqual(["S2"]);
  });

  it("keeps the chosen cards when an uncited answer is about them", async () => {
    const r = await run(
      [
        { calls: [{ name: "search_books", args: { author: "J.K. Rowling" } }] },
        { text: "All of them already have covers.", calls: [{ name: "show_books", args: { ids: ["S1", "S2"] } }] },
      ],
      { messages: [user("Only with covers.")], sources: {} },
      mockFetch({ "search.json": rowlingSearch }),
    );
    expect(r.books).toEqual(["S1", "S2"]);
  });

  it("marks search results the user has already seen, so 'more books' can skip them", async () => {
    const seen = new SourceRegistry();
    const first = rowlingSearch.docs[0];
    seen.upsertFromSearch({ workKey: first.key, title: first.title!, authors: first.author_name!, authorKeys: [] });
    const r = await run(
      [{ calls: [{ name: "search_books", args: { author: "J.K. Rowling" } }] }, { text: "Here are more." }],
      {
        messages: [user("Find books by J.K. Rowling."), { role: "assistant", content: "One [S1].", bookIds: ["S1"] }, user("Show me more.")],
        sources: Object.fromEntries(seen.all().map((b) => [b.id, b])),
      },
      mockFetch({ "search.json": rowlingSearch }),
    );
    const toolMsg = (r.requests[1].messages as { role: string; content: string }[]).find((m) => m.role === "tool")!;
    const results = JSON.parse(toolMsg.content).results as { id: string; already_shown?: boolean }[];
    expect(results.find((b) => b.id === "S1")?.already_shown).toBe(true);
    expect(results.find((b) => b.id !== "S1")?.already_shown).toBeUndefined();
  });

  it("removes a recommendation nobody asked for, and keeps one that was requested", async () => {
    const { dropUnaskedRecommendation } = await import("@/lib/agent");
    const answer = "- A [S1]\n\n**Recommendation (AI suggestion):** Start with A [S1]. Not a ranking.\n\nWant more?";
    expect(dropUnaskedRecommendation(answer, "Find books about AI.")).toBe("- A [S1]\n\nWant more?");
    expect(dropUnaskedRecommendation(answer, "Which of these is best for a beginner?")).toBe(answer);
    expect(dropUnaskedRecommendation(answer, "Recommend three books.")).toBe(answer);
  });

  it("answers 'the second result' itself when no list has been shown", async () => {
    const r = await run([{ text: "should not be called" }], { messages: [user("Tell me more about the second result.")], sources: {} }, mockFetch({}));
    expect(r.requests).toHaveLength(0);
    expect(r.text).toContain("haven't shown you a list");
    expect(r.books).toBeUndefined();
  });

  it("removes a line the model repeated verbatim, and nothing else", async () => {
    const { dropRepeatedLines } = await import("@/lib/agent");
    expect(dropRepeatedLines("Only books.\nOnly books.")).toBe("Only books.");
    expect(dropRepeatedLines("- A [S1]\n\n- B [S2]\n\n- A [S1]")).toBe("- A [S1]\n\n- B [S2]\n\n- A [S1]");
  });

  it("strips an echoed internal display note", async () => {
    const { stripDisplayNote } = await import("@/lib/agent");
    expect(stripDisplayNote("Here you go [S1].\n\n[Books displayed to the user, in order: S1, S2]")).toBe("Here you go [S1].");
  });
});
