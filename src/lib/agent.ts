import type OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";
import { SYSTEM_PROMPT } from "./prompt";
import { SourceRegistry, sourceForModel } from "./sources";
import { hasCover } from "./format";
import { TOOLS, executeTool, describeToolCall, type ToolContext } from "./tools";
import { extractCitationIds } from "./citations";
import type { BookSource, ChatRequestBody, StreamEvent } from "./types";

const MAX_ROUNDS = 6;
// Two attempts have to fit inside the route's 60 second limit, and a stalled AI response must never hang.
const STALL_MS = 15_000;
const DEADLINE_MS = 27_000;

/** The AI went quiet or the attempt ran too long. The route retries once if nothing has been shown yet. */
export class AgentTimeoutError extends Error {
  constructor() {
    super("The answer took too long.");
    this.name = "AgentTimeoutError";
  }
}
const MAX_HISTORY = 16;
const MAX_CONTEXT_RECORDS = 40;

export interface AgentOptions {
  openai: OpenAI;
  model: string;
  body: ChatRequestBody;
  emit: (e: StreamEvent) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  limits?: { stallMs: number; deadlineMs: number };
}

export const SOURCE_DOWN_MESSAGE = "I couldn't reach Open Library or Apple Books, so I can't answer from real book data right now. Please try again in a minute.";

const DISPLAY_NOTE = "App note: book cards displayed to the user under the previous answer, in order:";

/** Remove any copy of the internal display note that a model may have echoed into its answer. */
export function stripDisplayNote(text: string): string {
  return text.replace(/\n*\[?(?:App note: book cards displayed|Books displayed to the user)[^\n]*\]?\s*$/i, "").trimEnd();
}

/** If the user asked to filter by covers, the covered books from the most recent multi-book list. */
export function coverFilterFallback(body: ChatRequestBody, registry: SourceRegistry): string[] {
  const asked = body.messages[body.messages.length - 1]?.content ?? "";
  if (!/\b(with|have|has|having|only)\b.*\bcovers?\b/i.test(asked)) return [];
  const list = [...body.messages].reverse().find((m) => m.role === "assistant" && (m.bookIds?.length ?? 0) > 1);
  return (list?.bookIds ?? []).filter((id) => {
    const s = registry.get(id);
    return s && hasCover(s);
  });
}

/** Remove a non-empty line that exactly repeats the previous non-empty line. */
export function dropRepeatedLines(text: string): string {
  let last = "";
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      const repeated = t === last;
      last = t;
      return !repeated;
    })
    .join("\n");
}

/** Turn the client conversation into model messages, annotated with what the user saw. */
const ASKS_FOR_ADVICE = /recommend|suggest|\bbest\b|\bbetter\b|compare|\brank|\bpick\b|\bchoose\b|should i|good for|which (one|of|book)|worth|start with/i;

/** The labelled recommendation is for requests that want one; a plain "find books" gets only facts. */
export function dropUnaskedRecommendation(answer: string, userMessage: string) {
  if (ASKS_FOR_ADVICE.test(userMessage)) return answer;
  return answer.replace(/\n*\*\*Recommendation \(AI suggestion\):\*\*[^\n]*(\n(?!\n)[^\n]*)*/g, "").trimEnd();
}

const WANTS_NEW_RE = /\b(more|other|additional)\s+(books?|titles?|results?)\b|\bshow (me )?more\b/i;
/** "Show me more books…": the user wants books they haven't seen, which the model can't be relied on to track. */
export function wantsNewBooks(body: ChatRequestBody) {
  const last = body.messages[body.messages.length - 1];
  return last?.role === "user" && WANTS_NEW_RE.test(last.content);
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"];
// "the second result" at the end of a request, but not "the second book in the series" or "Rowling's first book".
const POSITION_RE = new RegExp(`\\bthe\\s+(${ORDINALS.join("|")}|\\d+(?:st|nd|rd|th))\\s+(?:result|one|book|title)\\s*(?:[.?!,]|$)`, "i");
export const NO_LIST_MESSAGE = "I haven't shown you a list of books in this conversation yet, so I can't tell which one you mean. What would you like to search for?";

/** A position that can't exist has one honest answer, so it never reaches the model. */
export function missingPositionReply(body: ChatRequestBody): string | null {
  const last = body.messages[body.messages.length - 1];
  const match = last?.role === "user" ? last.content.match(POSITION_RE) : null;
  if (!match) return null;
  const lists = body.messages.filter((m) => (m.bookIds?.length ?? 0) > 0);
  if (!lists.length) return NO_LIST_MESSAGE;
  const list = [...lists].reverse().find((m) => m.bookIds!.length > 1) ?? lists[lists.length - 1];
  const word = match[1].toLowerCase();
  const position = ORDINALS.indexOf(word) + 1 || parseInt(word, 10);
  const shown = list.bookIds!.length;
  if (position <= shown) return null;
  return `I only showed ${shown} result${shown === 1 ? "" : "s"}, so there isn't a ${word} one. Which of ${shown === 1 ? "them" : `the ${shown}`} would you like to know more about?`;
}

/**
 * Book records never hold chapter-level detail, so a chapter breakdown can only have come from the
 * model's memory, whatever it cites. Replace it with what the record does say.
 */
export function guardInventedChapters(answer: string, registry: SourceRegistry) {
  const chapter = /\bchapter\s+\d+/gi;
  if ((answer.match(chapter) ?? []).length < 2) return answer;
  const cited = extractCitationIds(answer).map((id) => registry.get(id)).filter((s): s is BookSource => !!s);
  if (cited.some((s) => /\bchapter\s+\d+/i.test(s.description ?? ""))) return answer;
  const source = cited[0];
  if (!source) return "I don't have chapter-level details for that book in the available book data.";
  const intro = `${source.sourceName} doesn't have a chapter-by-chapter breakdown of **${source.title}**, so I can't give one.`;
  if (!source.description) return `${intro} It has no description for this book either [${source.id}].`;
  const text = source.description.replace(/\s+/g, " ").trim();
  const short = text.length > 320 ? `${text.slice(0, 320).replace(/\s+\S*$/, "")}…` : text;
  return `${intro} Its description says: "${short}" [${source.id}]`;
}

const WANTS_RECOMMENDATION = /recommend|suggest|\bbest\b|should i\b|good for|compare|\brank|\bpick\b/i;
const REC_LABEL = "**Recommendation (AI suggestion):**";

/** The brief requires opinions to be labelled, so a recommendation that forgot its label gets one. */
export function ensureRecommendationLabel(answer: string, userMessage: string) {
  if (!WANTS_RECOMMENDATION.test(userMessage) || answer.includes(REC_LABEL)) return answer;
  if (!extractCitationIds(answer).length || /don['’]t have enough|do not have enough/i.test(answer)) return answer;
  return `${answer.trimEnd()}\n\n${REC_LABEL} The choices above are my suggestion based on the available descriptions and subjects, not a ranking by sales or reviews.`;
}

export function buildMessages(body: ChatRequestBody, registry: SourceRegistry): ChatCompletionMessageParam[] {
  const history = body.messages.slice(-MAX_HISTORY);
  const msgs: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const seen = new Set(body.messages.flatMap((m) => m.bookIds ?? []));

  const known = registry
    .all()
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))
    .slice(0, MAX_CONTEXT_RECORDS)
    .filter((s) => !(wantsNewBooks(body) && seen.has(s.id)))
    .map((s) => (seen.has(s.id) ? { ...sourceForModel(s), already_shown: true } : sourceForModel(s)));
  if (known.length) {
    msgs.push({
      role: "system",
      content: `Records already retrieved in this conversation (newest first). You may cite these ids:\n${JSON.stringify(known)}`,
    });
  }

  for (const m of history) {
    if (m.role === "user") {
      msgs.push({ role: "user", content: String(m.content).slice(0, 4000) });
    } else {
      msgs.push({ role: "assistant", content: stripDisplayNote(m.content) || "(no text)" });
      const shown = (m.bookIds ?? []).map((id) => registry.get(id)).filter((s): s is BookSource => !!s);
      // Sent as a separate app note (not part of the assistant's words) so the model
      // resolves "the second result" against what the user actually saw, without imitating it.
      if (shown.length) {
        msgs.push({
          role: "system",
          content:
            `${DISPLAY_NOTE} ` +
            shown
              .map((s, i) => `${i + 1}. ${s.id} "${s.title}" — ${s.authors.join(", ") || "unknown author"}${s.firstPublishYear ? ` (${s.firstPublishYear})` : ""}, cover: ${hasCover(s) ? "yes" : "no"}`)
              .join("; "),
        });
      }
    }
  }
  return msgs;
}

export async function runAgent(options: AgentOptions): Promise<void> {
  const { signal, limits } = options;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel);

  let timedOut = false;
  const giveUp = () => {
    timedOut = true;
    cancel();
  };
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineTimer = setTimeout(giveUp, limits?.deadlineMs ?? DEADLINE_MS);
  const clock = {
    /** Restarts the "AI has gone quiet" timer. */
    alive: () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(giveUp, limits?.stallMs ?? STALL_MS);
    },
    /** Book lookups have their own timeouts, so only the overall deadline applies to them. */
    pause: () => clearTimeout(stallTimer),
    check: () => {
      if (timedOut) throw new AgentTimeoutError();
    },
    aborted: new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(timedOut ? new AgentTimeoutError() : new DOMException("Aborted", "AbortError")));
    }),
  };
  clock.aborted.catch(() => {});

  try {
    await runRounds(options, controller.signal, clock);
  } catch (err) {
    if (timedOut) throw new AgentTimeoutError();
    throw err;
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", cancel);
  }
}

async function runRounds(
  { openai, model, body, emit, fetchImpl }: AgentOptions,
  signal: AbortSignal,
  clock: { alive: () => void; pause: () => void; check: () => void; aborted: Promise<never> },
): Promise<void> {
  const positionReply = missingPositionReply(body);
  if (positionReply) {
    emit({ type: "text", delta: positionReply });
    return;
  }
  const registry = new SourceRegistry(body.sources);
  const alreadyShown = new Set(body.messages.flatMap((m) => m.bookIds ?? []));
  const ctx: ToolContext = { registry, fetchImpl, shownIds: null, alreadyShown, onlyNewBooks: wantsNewBooks(body) };
  const messages = buildMessages(body, registry);
  let answer = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lastRound = round === MAX_ROUNDS - 1;
    clock.alive();
    const stream = await openai.chat.completions.create(
      {
        model,
        messages,
        tools: TOOLS,
        tool_choice: lastRound ? "none" : "auto",
        stream: true,
      },
      { signal },
    );

    const answerBeforeRound = answer;
    let roundText = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      clock.alive();
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        if (!roundText && answer) {
          // A new block of text after tool calls: keep paragraphs separate.
          emit({ type: "text", delta: "\n\n" });
          answer += "\n\n";
        }
        roundText += delta.content;
        answer += delta.content;
        emit({ type: "text", delta: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
    clock.check(); // an aborted stream ends without an error

    if (!calls.size) break; // final answer produced

    // The model wrote a preamble and then decided it needs more data. Drop that text so the
    // final answer isn't duplicated (it will be rewritten once the data is in).
    if (roundText.trim() && [...calls.values()].some((c) => c.name !== "show_books")) {
      answer = answerBeforeRound;
      emit({ type: "reset", content: answer });
    }

    const toolCalls: ChatCompletionMessageFunctionToolCall[] = [...calls.values()].map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.args || "{}" },
    }));
    messages.push({ role: "assistant", content: roundText || null, tool_calls: toolCalls });

    for (const c of calls.values()) {
      if (c.name !== "show_books") {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(c.args || "{}");
        } catch {}
        emit({ type: "status", message: describeToolCall(c.name, parsed, registry) });
      }
    }

    clock.pause();
    const results = await Promise.race([Promise.all(toolCalls.map((tc) => executeTool(tc.function.name, tc.function.arguments, ctx))), clock.aborted]);
    toolCalls.forEach((tc, i) => messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(results[i]) }));

    // The model wrote its answer and attached cards in the same turn: we're done.
    // (Looping again would make it repeat the answer.)
    if (roundText.trim() && toolCalls.every((tc) => tc.function.name === "show_books")) break;

    const touched = registry.touchedSources();
    if (touched.length) emit({ type: "sources", sources: touched });
    emit({ type: "status", message: "Writing answer…" });
  }

  // Guardrail: surface (server-side) any citation the model made up. The client drops them on render.
  const invalid = extractCitationIds(answer).filter((id) => !registry.has(id));
  if (invalid.length) console.warn(`[agent] model cited unknown ids: ${invalid.join(", ")}`);

  // Models occasionally repeat a line verbatim, or add advice to a plain search; never show those.
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const cleaned = ensureRecommendationLabel(dropUnaskedRecommendation(guardInventedChapters(dropRepeatedLines(answer), registry), lastUser), lastUser);
  if (cleaned !== answer) {
    answer = cleaned;
    emit({ type: "reset", content: answer });
  }

  // The book sources failed and the answer has no sourced facts: show the app's own error card with
  // "Try again" instead of whatever the model improvised. Answers citing real records are kept.
  if (ctx.sourceFailed && !extractCitationIds(answer).some((id) => registry.has(id))) {
    emit({ type: "reset", content: "" });
    emit({ type: "error", message: SOURCE_DOWN_MESSAGE });
    return;
  }

  if (!answer.trim()) {
    const msg = "Sorry — I couldn't produce an answer for that. Please try rephrasing.";
    emit({ type: "text", delta: msg });
  }
  // If the model forgot show_books (or passed nothing), show cards for the records it cited, in citation order.
  // The same applies when the cards and the text are about entirely different books.
  const cited = extractCitationIds(answer).filter((id) => registry.has(id));
  const cardsMatchText = ctx.shownIds?.length && (!cited.length || ctx.shownIds.some((id) => cited.includes(id)));
  let shownIds = cardsMatchText ? ctx.shownIds! : cited;
  if (ctx.onlyNewBooks) shownIds = shownIds.filter((id) => !alreadyShown.has(id));
  // Same safety net for the cover filter: re-show the last result list, minus books without covers.
  if (!shownIds.length && !ctx.shownIds) shownIds = coverFilterFallback(body, registry);
  if (shownIds.length) emit({ type: "books", ids: shownIds });
}

/** Map provider errors to messages a user can act on. */
export function friendlyError(err: unknown): string {
  const e = err as { status?: number; code?: string; message?: string; name?: string };
  if (e?.name === "AgentTimeoutError") return "The AI service took too long to respond. Please try again.";
  if (e?.name === "AbortError") return "The request was cancelled.";
  if (e?.status === 401) return "The OpenAI API key is missing or invalid. Check OPENAI_API_KEY in your .env.local.";
  if (e?.status === 429) return "The AI service is rate-limited or out of quota right now. Please wait a moment and try again.";
  if (e?.status === 404 || e?.code === "model_not_found") return "The configured OpenAI model is not available for this key. Set OPENAI_MODEL in .env.local (e.g. gpt-4o-mini).";
  if (e?.constructor?.name === "APIConnectionTimeoutError") return "The AI service took too long to respond. Please try again.";
  if (e?.constructor?.name === "APIConnectionError" || /connection error/i.test(e?.message ?? ""))
    return "Couldn't reach the AI service. Check the server's internet connection and try again.";
  if (e?.status && e.status >= 500) return "The AI service had a temporary problem. Please try again.";
  return "Something went wrong while generating the answer. Please try again.";
}
