# Shelf — AI Book Discovery Chatbot

A conversational book-discovery app. Ask about authors, titles and topics; answers are grounded in **Open Library** data, every fact carries an **inline citation** with a hover/click preview, and AI opinions are clearly labeled as suggestions.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · OpenAI Chat Completions (tool calling, streaming) · Open Library API · Vitest

---

## Run locally

Requires **Node.js 18.18+** (20+ recommended).

```bash
git clone <repo-url> && cd book-discovery-chat
npm install
cp .env.example .env.local        # then put your key in OPENAI_API_KEY
npm run dev                       # http://localhost:3000
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | yes | — | Server-side only; never sent to the browser. |
| `OPENAI_MODEL` | no | `gpt-4.1-mini` | Any Chat Completions model with tool calling (e.g. `gpt-4o-mini`, `gpt-4.1`, `gpt-4o`). |

Other scripts:

```bash
npm test          # unit + agent-loop tests (no network, no API key needed)
npm run lint      # TypeScript type-check
npm run build && npm start   # production build
```

### Deploy (Vercel)
Import the repo in Vercel → add `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) under *Environment Variables* → Deploy. No other configuration needed.

---

## How it works

```
Browser (React)                         Next.js route  /api/chat                 External
───────────────                         ──────────────────────────               ────────
messages + source registry  ──POST──▶   agent loop (max 6 rounds)
                                          │  OpenAI (stream, tools) ◀──────────▶ OpenAI
                                          │   ├─ search_books      ───────────▶ openlibrary.org/search.json
                                          │   ├─ get_book_details  ───────────▶ openlibrary.org/works/{id}.json
                                          │   └─ show_books (chooses cards)
        ◀── NDJSON stream: status · sources · text deltas · books · error · done
```

1. **Tools, not memory.** The model has three tools: `search_books` (author/title/subject/free-text, sort, cover filter), `get_book_details` (description, subjects, first-publication date) and `show_books` (which cards to render, in order). The system prompt forbids stating any title/author/date/fact that didn't come from a tool result.
2. **Source registry.** Every Open Library work retrieved gets a stable conversation-scoped id (`S1`, `S2`…), deduplicated by work key. The model cites ids like `[S3]`; it never writes URLs — links are built server-side from the work key.
3. **Citation rendering.** The client renumbers ids per message (`[1]`, `[2]`…) in order of appearance, drops any id that isn't in the registry (so an invented source can't render), and shows a popover with source name, title, author, first-published date, editions, a description snippet and a **View source ↗** link.
4. **Follow-ups.** The client keeps the transcript and the registry (persisted in `localStorage`). Each prior assistant turn is replayed to the model with an annotation of the exact cards the user saw — `Books displayed: 1. S4 "…" — author (year), cover: yes` — so "the second result", "the author of the first one" and "only ones with covers" resolve deterministically.
5. **Facts vs opinions.** Recommendations go under **Recommendation (AI suggestion):** and state what they're based on ("based on the Open Library descriptions — not a ranking by sales or reviews"). Questions the data can't answer (sales, ratings, prices) get an explicit "I don't have enough information from the available Open Library data…".
6. **Reliability.** Open Library calls have a 9 s timeout, one retry and a 10-minute in-memory cache; failures are returned to the model as tool errors so it tells the user instead of guessing. OpenAI errors (bad key, quota, model not found, network) map to readable messages with a **Try again** button. Cards/popovers render cleanly with missing covers, authors, years or descriptions.

### Project layout

```
src/
  app/api/chat/route.ts    request validation (zod), NDJSON streaming, error mapping
  lib/agent.ts             tool-calling loop, history building, guardrails
  lib/tools.ts             tool schemas + execution
  lib/openlibrary.ts       Open Library client (timeouts, retry, cache, normalization)
  lib/sources.ts           conversation source registry (stable S# ids)
  lib/citations.ts         citation parsing / validation / renumbering
  lib/prompt.ts            system prompt (grounding, citation, recommendation rules)
  components/              Chat shell, message renderer, citation popover, book cards
tests/                     Vitest: citations, Open Library client, agent loop (fake OpenAI + fixtures)
```

## Required test scenarios

| Scenario | What happens |
|---|---|
| *Find books by J.K. Rowling.* | `search_books(author, sort=editions)` → cards + cited summary |
| *Find introductory books about artificial intelligence.* | subject search → details for top hits → cited list, "introductory" judgment labeled as AI suggestion |
| *Who wrote Kindred and when was it first published?* | title search (+ details) → "Octavia E. Butler … 1979 [1]" |
| *Only show books with cover images.* | filters the last displayed list via `has_cover`, re-renders cards, says how many were removed |
| *Tell me more about the second result.* | resolves #2 from the displayed list → `get_book_details` → description/subjects with citations |
| *Recommend three books about startups for a beginner.* | search + details → three cards, recommendation section clearly labeled |
| *Which of these books sold the most copies last year?* | states the data doesn't include sales; offers what it does have (e.g. edition counts, clearly not sales) |

## Security notes
- The API key lives only in server env vars; `.env*` is git-ignored.
- Request bodies are validated and size-capped; Open Library links are generated from work keys, never from model output; markdown links in answers open in a new tab with `rel="noopener noreferrer"`.
