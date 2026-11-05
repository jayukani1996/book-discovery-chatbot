import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { getWork, searchBooks, OpenLibraryError, OpenLibraryUnavailableError, type SearchParams } from "./openlibrary";
import { SourceRegistry, sourceForModel } from "./sources";

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_books",
      description:
        "Search Open Library for books (works). Provide at least one of query, title, author, subject. Returns records with ids you can cite and show.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search across titles, authors and subjects." },
          title: { type: "string", description: "Book title (use for a specific book)." },
          author: { type: "string", description: "Author name." },
          subject: { type: "string", description: "Topic/subject, e.g. 'artificial intelligence', 'startups'." },
          sort: {
            type: "string",
            enum: ["relevance", "editions", "new", "old"],
            description: "'editions' surfaces well-known works first (good for author searches).",
          },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Number of results (default 8)." },
          only_with_covers: { type: "boolean", description: "Return only books that have a cover image." },
          language: { type: "string", description: "Optional ISO 639-2 language code filter, e.g. 'eng'." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_book_details",
      description:
        "Fetch the full Open Library record (description, subjects, first publication date) for already-retrieved books. Use before describing a book's content or judging suitability.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, description: "Record ids such as 'S3'." },
        },
        required: ["ids"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_books",
      description:
        "Display book cards to the user under your answer, in the given order. Call once per answer with the books your answer is about. Pass an empty list to show none.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, maxItems: 20, description: "Record ids in display order." },
        },
        required: ["ids"],
        additionalProperties: false,
      },
    },
  },
];

export interface ToolContext {
  registry: SourceRegistry;
  fetchImpl?: typeof fetch;
  /** Set by show_books; the final list of cards to render. */
  shownIds: string[] | null;
  /** Ids the user has already seen as cards in this conversation. */
  alreadyShown?: Set<string>;
  /** Set when Open Library could not be reached during this request. */
  sourceFailed?: boolean;
}

export function describeToolCall(name: string, args: Record<string, unknown>, registry: SourceRegistry): string {
  if (name === "search_books") {
    const parts: string[] = [];
    if (args.author) parts.push(`books by ${args.author}`);
    if (args.title) parts.push(`"${args.title}"`);
    if (args.subject) parts.push(`books about ${args.subject}`);
    if (args.query) parts.push(`"${args.query}"`);
    return `Searching Open Library for ${parts.join(", ") || "books"}…`;
  }
  if (name === "get_book_details") {
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
    const titles = ids.map((id) => registry.get(String(id))?.title).filter(Boolean);
    return titles.length ? `Reading details for ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? "…" : ""}` : "Reading book details…";
  }
  return "Preparing results…";
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { error: "Invalid JSON arguments." };
  }

  try {
    switch (name) {
      case "search_books": {
        const params: SearchParams = {
          query: str(args.query),
          title: str(args.title),
          author: str(args.author),
          subject: str(args.subject),
          sort: (["relevance", "editions", "new", "old"] as const).find((s) => s === args.sort),
          limit: typeof args.limit === "number" ? args.limit : undefined,
          onlyWithCovers: args.only_with_covers === true,
          language: str(args.language),
        };
        const { total, hits } = await searchBooks(params, ctx.fetchImpl);
        const records = hits.map((h) => {
          const record = sourceForModel(ctx.registry.upsertFromSearch(h));
          return ctx.alreadyShown?.has(record.id) ? { ...record, already_shown: true } : record;
        });
        return {
          total_matches: total,
          returned: records.length,
          results: records,
          note: records.length ? undefined : "No matching books found on Open Library.",
        };
      }

      case "get_book_details": {
        const ids = (Array.isArray(args.ids) ? args.ids : []).map((x) => String(x).toUpperCase()).slice(0, 5);
        const results = await Promise.all(
          ids.map(async (id) => {
            const src = ctx.registry.get(id);
            if (!src) return { id, error: "Unknown id. Only use ids from search results." };
            try {
              const details = await getWork(src.workKey, ctx.fetchImpl);
              const updated = ctx.registry.applyDetails(id, details)!;
              const out = sourceForModel(updated, { full: true });
              return { ...out, description: out.description ?? "(Open Library has no description for this book.)" };
            } catch (e) {
              if (e instanceof OpenLibraryUnavailableError) ctx.sourceFailed = true;
              return { id, error: e instanceof Error ? e.message : "Failed to load details." };
            }
          }),
        );
        return { results };
      }

      case "show_books": {
        const ids = (Array.isArray(args.ids) ? args.ids : []).map((x) => String(x).toUpperCase());
        const valid = [...new Set(ids)].filter((id) => ctx.registry.has(id));
        const unknown = ids.filter((id) => !ctx.registry.has(id));
        ctx.shownIds = valid;
        return { shown: valid.length, ...(unknown.length ? { ignored_unknown_ids: unknown } : {}) };
      }

      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (e) {
    if (e instanceof OpenLibraryUnavailableError) ctx.sourceFailed = true;
    const msg = e instanceof OpenLibraryError ? e.message : "The book data source failed unexpectedly.";
    return { error: msg, instruction: "Tell the user the book data could not be retrieved right now; do not answer from memory." };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
