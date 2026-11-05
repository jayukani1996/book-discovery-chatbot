import OpenAI from "openai";
import { z } from "zod";
import { runAgent, friendlyError } from "@/lib/agent";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import type { ChatRequestBody, StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Chosen after running the required scenarios against several models (best citation/label adherence). */
const DEFAULT_MODEL = "gpt-5.4-mini";
/** Used automatically if the key has no access to the configured model. */
const FALLBACK_MODEL = "gpt-4.1-mini";

const BodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20000),
        bookIds: z.array(z.string()).max(40).optional(),
      }),
    )
    .min(1)
    .max(60),
  sources: z.record(z.string(), z.any()).default({}),
});

export async function POST(req: Request) {
  const limit = rateLimit(clientIp(req));
  if (!limit.ok) {
    return Response.json(
      { error: `You're sending messages too quickly. Please wait ${limit.retryAfterSec}s and try again.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  let body: ChatRequestBody;
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
    body = parsed.data as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const last = body.messages[body.messages.length - 1];
  if (last.role !== "user" || !last.content.trim()) {
    return Response.json({ error: "The last message must be a non-empty user message." }, { status: 400 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "Server is missing OPENAI_API_KEY. Copy .env.example to .env.local and add your key." },
      { status: 500 },
    );
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2, timeout: 45_000 });
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          /* client disconnected */
        }
      };
      let emitted = false;
      const tracked = (e: StreamEvent) => {
        emitted = true;
        emit(e);
      };
      try {
        try {
          await runAgent({ openai, model, body, emit: tracked, signal: req.signal });
        } catch (err) {
          const e = err as { status?: number; code?: string };
          const modelMissing = e?.status === 404 || e?.code === "model_not_found";
          if (!modelMissing || emitted || model === FALLBACK_MODEL) throw err;
          console.warn(`[api/chat] model "${model}" unavailable, falling back to ${FALLBACK_MODEL}`);
          await runAgent({ openai, model: FALLBACK_MODEL, body, emit, signal: req.signal });
        }
      } catch (err) {
        console.error("[api/chat]", err);
        emit({ type: "error", message: friendlyError(err) });
      } finally {
        emit({ type: "done" });
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
