# Submission summary

## What I built
**Shelf**, a chat app for discovering books. A Next.js app streams answers from an OpenAI tool-calling agent that pulls all its facts from the Open Library API. Answers come with book cards (cover, author, first-publication year, edition count, description or subjects, source link) and numbered inline citations. Hovering or clicking a citation opens a preview with the source name, title, author, first-published date, a description snippet and a "View source ↗" link. Follow-up questions work: "the second result", "the author of the first one" and "only ones with covers" all resolve against the cards the user actually saw.

## What I prioritized
1. **Accuracy you can check.** The model may only state facts that came back from tools, and it cites them with registry ids (`[S3]`). The client throws away any id that isn't in the registry. URLs are built from Open Library work keys and never from model text. Questions the data can't answer (sales, ratings) get an explicit "not available in the data" response.
2. **Citation UX.** Markers sit right after the claim they support, are numbered per answer, and the preview works on hover, keyboard focus and tap.
3. **Reliable follow-ups.** Each earlier turn is replayed to the model along with the exact ordered list of cards shown. Ordinal references and filters are therefore deterministic and don't depend on the model's memory.
4. **Graceful failure.** Open Library calls have timeouts, a retry and a cache. Tool errors are fed back to the model so it can explain them to the user. Provider errors are turned into readable messages with a retry button. Missing covers, authors, years or descriptions all render cleanly.
5. **Product feel.** Light and dark themes with a remembered toggle (following the OS by default, with no flash on load), AA text contrast in both, visible keyboard focus, streaming text, live status lines ("Searching Open Library for books by J.K. Rowling…"), a stop button, suggested follow-ups, the conversation surviving a refresh, and a responsive layout.

## Tradeoff worth discussing
I chose **Open Library search plus on-demand detail fetches** over pre-indexing a vector store. The upside: it's always current, there's no infrastructure, and every claim traces to a live record. The downside: search relevance depends on Open Library's ranking. For example, the "artificial intelligence" subject returns some academic titles. The model has to pick from what comes back and can't do a semantic search over the whole catalogue. A second tradeoff: conversation state (transcript plus registry) lives in the client, which keeps the server stateless and easy to deploy. Before production I'd move it server-side so a client can't tamper with source records.

**A second tradeoff: the backup source.** I kept one main source and added Apple Books only for when Open Library refuses. That keeps the demo working, at the cost of weaker data while it is in use: no first publication dates, and a noisier catalog. I chose to label that clearly and have the bot admit the gap rather than mix in dates it can't support.

## How I tested it
- **Unit and agent tests** (`npm test`, 60 tests, no network): citation parsing, Open Library normalization, the agent loop with a fake OpenAI client, and the guardrails.
- **Live evaluation suite** (`npm run eval`, 17 turns): the 7 required scenarios plus adversarial cases (fabrication pressure, prompt injection, impossible ordinals, no results, off-topic). It checks invariants on every turn: no unknown citation ids, no model-written URLs, no leaked internals, and card links that are Open Library work URLs. It passed 17/17 against the live services with Open Library, with a median answer time of about 3 s. Open Library then started refusing my IP, which led to the Apple Books backup. The final, stricter version passed 17/17 on two consecutive runs against the live OpenAI and Apple Books APIs. I also compared each card from a browser run with Apple's own record (titles, authors, dates, covers, links).
- **Browser QA** in headless Chrome at desktop and mobile sizes, 24 checks: loading state, citation preview on hover, keyboard focus, click and tap, Escape and click-outside, refresh persistence, Stop, New chat, a network failure followed by Try again, missing-cover placeholders, no horizontal overflow on mobile, and zero console errors.

Bugs this testing found and fixed: the bot writing code when asked (it now stays on books), a cover filter that sometimes left no cards on screen, a citation preview that covered its own marker when opened low on the screen (which also broke tapping on phones), an invented chapter-by-chapter summary when the user pushed for one, conversation history being wiped on refresh, invalid HTML nesting in the citation preview, a re-search when the user asked for a result position that didn't exist, citation clutter, and inconsistent first-publication dates between Open Library endpoints.

## Model choice
I ran the required scenarios end-to-end against three models. `gpt-4.1-mini` sometimes grouped all citations at the end, skipped the recommendation label, or leaked tool JSON into the answer. `gpt-4.1` answered some factual questions without citations. `gpt-5.4-mini` cited every factual answer inline and labeled every recommendation, at 2–7 s per answer, so it is the default. If a key can't access it, the server falls back to `gpt-4.1-mini` automatically. I also added code-level guardrails so correctness doesn't rest on the prompt alone: preamble text is discarded before more tool calls, cards fall back to cited records, and invented ids are dropped.

## What I'd improve with more time / before production
- **Automatic grounding check.** A post-answer verifier that confirms each cited sentence's numbers and names appear in the cited record, flagging or regenerating when they don't.
- Server-side sessions (Redis/Postgres), auth, rate limiting per user, and a shared cache for Open Library responses.
- Better retrieval: query rewriting, merging several searches (subject plus free text), and re-ranking by description quality and edition count. Fetch author bios for author questions.
- Run the evaluation suite (`npm run eval`, already included) in CI on every prompt or model change, and grow it with real user questions.
- Observability (traces of tool calls, token and cost tracking), and turn my headless-Chrome QA checks into a committed Playwright suite.
- Accessibility pass (screen-reader text for citations, focus trapping in popovers) and dark mode.

## Known limitations
- Open Library's `first_publish_year` is the earliest edition it knows about, so it is sometimes wrong for translations or reissues. The bot attributes the date to Open Library.
- Many works have no description, so "tell me more" or "best for beginners" can only use titles and subjects. The bot says when that's the case.
- Grounding is enforced by the prompt plus citation validation, not proven sentence by sentence. A model could still paraphrase a record loosely.
- Conversation history sent to the model is capped at the last 16 messages and 40 known records.
- Open Library can refuse an IP after bursts of traffic, which happened during testing. The app then uses Apple Books, a store catalog: its dates are ebook release dates, so it can't answer "when was this first published?", and the bot says so. Its results are also noisier, so some listings are weaker matches than Open Library's. If both sources refuse, book questions show an error card.
- The final version was tested live with Apple Books, because Open Library was still refusing my IP. Its Open Library path was covered by unit tests and earlier live runs.
- The rate limit (20 requests/minute per IP) is in memory per server instance, so it protects a demo but isn't a production quota system.
- Open Library data has its own errors (e.g. *Song of Solomon* listed as first published in 1634, SparkNotes listed as a co-author of *Kindred*). The bot reports the data faithfully and flags clearly implausible dates.

## Time spent
About 4–5 hours, working with AI coding tools.

## AI tools used
- **Claude (claude.ai)** built the first version: the project scaffold, agent, UI, tests and docs. That environment had no internet, so the first version was tested only against recorded Open Library data and simulated model responses.
- **Claude Code (Anthropic)** handled verification and hardening against the live APIs. It drove `/api/chat` with scripts the same way the browser does, compared models, ran browser QA in headless Chrome, and fixed what the testing found: bunched citations, duplicated answers, a fabricated chapter summary, lost history on refresh, a filter applied to the wrong list, missing recommendation labels, and inconsistent publication dates.
- My role was setting the requirements from the brief, deciding the tradeoffs (model choice, what to fix vs. document as a limitation), reviewing the output and running the scenarios.
