# Submission summary

## What I built
**Shelf**, a chat app for discovering books. A Next.js app streams answers from an OpenAI tool-calling agent that pulls all its facts from the Open Library API. Answers come with book cards (cover, author, first-publication year, edition count, description or subjects, source link) and numbered inline citations. Hovering or clicking a citation opens a preview with the source name, title, author, first-published date, a description snippet and a "View source ↗" link. Follow-up questions work: "the second result", "the author of the first one" and "only ones with covers" all resolve against the cards the user actually saw.

## What I prioritized
1. **Accuracy you can check.** The model may only state facts that came back from tools, and it cites them with registry ids (`[S3]`). The client throws away any id that isn't in the registry. URLs are built from Open Library work keys and never from model text. Questions the data can't answer (sales, ratings) get an explicit "not available in the data" response.
2. **Citation UX.** Markers sit right after the claim they support, are numbered per answer, and the preview works on hover, keyboard focus and tap.
3. **Reliable follow-ups.** Each earlier turn is replayed to the model along with the exact ordered list of cards shown. Ordinal references and filters are therefore deterministic and don't depend on the model's memory.
4. **Graceful failure.** Open Library calls have timeouts, a retry and a cache. Tool errors are fed back to the model so it can explain them to the user. Provider errors are turned into readable messages with a retry button. Missing covers, authors, years or descriptions all render cleanly.
5. **Product feel.** Streaming text, live status lines ("Searching Open Library for books by J.K. Rowling…"), a stop button, suggested follow-ups, the conversation surviving a refresh, and a responsive layout.

## Tradeoff worth discussing
I chose **Open Library search plus on-demand detail fetches** over pre-indexing a vector store. The upside: it's always current, there's no infrastructure, and every claim traces to a live record. The downside: search relevance depends on Open Library's ranking. For example, the "artificial intelligence" subject returns some academic titles. The model has to pick from what comes back and can't do a semantic search over the whole catalogue. A second tradeoff: conversation state (transcript plus registry) lives in the client, which keeps the server stateless and easy to deploy. Before production I'd move it server-side so a client can't tamper with source records.

## What I'd improve with more time / before production
- **Automatic grounding check.** A post-answer verifier that confirms each cited sentence's numbers and names appear in the cited record, flagging or regenerating when they don't.
- Server-side sessions (Redis/Postgres), auth, rate limiting per user, and a shared cache for Open Library responses.
- Better retrieval: query rewriting, merging several searches (subject plus free text), and re-ranking by description quality and edition count. Fetch author bios for author questions.
- An evaluation harness: a scripted run of the 7 required scenarios plus adversarial prompts, scored on citation validity and refusals. Run it in CI on every prompt or model change.
- Observability (traces of tool calls, token and cost tracking), plus Playwright end-to-end tests against recorded fixtures.
- Accessibility pass (screen-reader text for citations, focus trapping in popovers) and dark mode.

## Known limitations
- Open Library's `first_publish_year` is the earliest edition it knows about, so it is sometimes wrong for translations or reissues. The bot attributes the date to Open Library.
- Many works have no description, so "tell me more" or "best for beginners" can only use titles and subjects. The bot says when that's the case.
- Grounding is enforced by the prompt plus citation validation, not proven sentence by sentence. A model could still paraphrase a record loosely.
- Conversation history sent to the model is capped at the last 16 messages and 40 known records.

## Time spent
~X hours *(fill in)*

## AI tools used
Claude Code (Anthropic) for scaffolding, implementation, tests and documentation. I reviewed and directed the architecture, prompts and UX decisions, and tested the scenarios manually against the live APIs.
