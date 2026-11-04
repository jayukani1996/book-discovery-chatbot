/**
 * Shared types between the server (agent) and the client (chat UI).
 *
 * A `BookSource` is a normalized Open Library work record. Every record the
 * agent retrieves gets a stable conversation-scoped id ("S1", "S2", ...).
 * The model may only cite these ids; the UI turns them into numbered
 * citation markers with hover previews.
 */

export interface BookSource {
  id: string; // "S1"
  workKey: string; // "/works/OL82563W"
  title: string;
  subtitle?: string;
  authors: string[];
  authorKeys: string[];
  firstPublishYear?: number;
  firstPublishDate?: string; // from work details, e.g. "June 1979"
  coverId?: number;
  editionCount?: number;
  pageCount?: number;
  subjects?: string[];
  description?: string;
  languages?: string[];
  url: string; // https://openlibrary.org/works/OL82563W
  sourceName: "Open Library";
  detailsFetched?: boolean;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Source ids of the book cards shown under this assistant message, in order. */
  bookIds?: string[];
  error?: string;
}

export interface ChatRequestBody {
  messages: Pick<ChatMessage, "role" | "content" | "bookIds">[];
  sources: Record<string, BookSource>;
}

/** Newline-delimited JSON events streamed from /api/chat. */
export type StreamEvent =
  | { type: "status"; message: string }
  | { type: "sources"; sources: BookSource[] }
  | { type: "text"; delta: string }
  | { type: "books"; ids: string[] }
  | { type: "error"; message: string }
  | { type: "done" };
