import type OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";
import { SYSTEM_PROMPT } from "./prompt";
import { SourceRegistry, sourceForModel } from "./sources";
import { TOOLS, executeTool, describeToolCall, type ToolContext } from "./tools";
import { extractCitationIds } from "./citations";
import type { BookSource, ChatRequestBody, StreamEvent } from "./types";

const MAX_ROUNDS = 6;
const MAX_HISTORY = 16;
const MAX_CONTEXT_RECORDS = 40;

export interface AgentOptions {
  openai: OpenAI;
  model: string;
  body: ChatRequestBody;
  emit: (e: StreamEvent) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Turn the client conversation into model messages, annotated with what the user saw. */
export function buildMessages(body: ChatRequestBody, registry: SourceRegistry): ChatCompletionMessageParam[] {
  const history = body.messages.slice(-MAX_HISTORY);
  const msgs: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];

  const known = registry
    .all()
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))
    .slice(0, MAX_CONTEXT_RECORDS)
    .map((s) => sourceForModel(s));
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
      let content = m.content || "(no text)";
      const shown = (m.bookIds ?? []).map((id) => registry.get(id)).filter((s): s is BookSource => !!s);
      if (shown.length) {
        content +=
          "\n\n[Books displayed to the user, in order: " +
          shown
            .map((s, i) => `${i + 1}. ${s.id} "${s.title}" — ${s.authors.join(", ") || "unknown author"}${s.firstPublishYear ? ` (${s.firstPublishYear})` : ""}, cover: ${s.coverId ? "yes" : "no"}`)
            .join("; ") +
          "]";
      }
      msgs.push({ role: "assistant", content });
    }
  }
  return msgs;
}

export async function runAgent({ openai, model, body, emit, fetchImpl, signal }: AgentOptions): Promise<void> {
  const registry = new SourceRegistry(body.sources);
  const ctx: ToolContext = { registry, fetchImpl, shownIds: null };
  const messages = buildMessages(body, registry);
  let answer = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lastRound = round === MAX_ROUNDS - 1;
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

    let roundText = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
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

    if (!calls.size) break; // final answer produced

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

    const results = await Promise.all(toolCalls.map((tc) => executeTool(tc.function.name, tc.function.arguments, ctx)));
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

  if (!answer.trim()) {
    const msg = "Sorry — I couldn't produce an answer for that. Please try rephrasing.";
    emit({ type: "text", delta: msg });
  }
  if (ctx.shownIds) emit({ type: "books", ids: ctx.shownIds });
}

/** Map provider errors to messages a user can act on. */
export function friendlyError(err: unknown): string {
  const e = err as { status?: number; code?: string; message?: string; name?: string };
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
