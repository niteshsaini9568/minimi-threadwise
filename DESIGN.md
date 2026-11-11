# Threadwise

**The difficult part is “since then”, not search.** Answering it requires the right conversation, the original constraints, a dated baseline, and current evidence. A current price alone cannot prove when a price changed.

## Request path

`Browser → timestamped SQLite history → context assembly → reasoning model + web_search → SSE → saved answer and evidence`

The server owns the clock; the browser supplies an IANA timezone. Calendar hints resolve the challenge's English date references without depending on the machine's timezone or daylight-saving offsets. We disclose the convention: “last Tuesday” is strictly before today; an omitted year means the most recent past occurrence. These are hints, not a replacement for clarification.

Every turn preserves the exact question, answer, UTC timestamp, timezone, source annotations, search activity, retrieval time, usage and completion status. Conversations share memory only within the same random, HttpOnly browser identity. We preserve history rather than rewriting it into a rolling summary. An earlier assistant statement records what was said, not what was true. Imported baselines are explicitly unverified.

Below 80,000 serialized characters, all prior turns go verbatim to one Responses API call. This avoids retrieval misses and extra orchestration on ordinary conversations. Above that bound, date, lexical and recency ranking constructs an index of at most 800 candidates. A tool-free structured selector chooses relevant turn IDs; the server validates them, pins date matches and recent current-thread context, and assembles whole records within the budget. Omission counts are visible. This is bounded recall, not a claim of perfect long-term memory.

The answering model has exactly one tool: native **web_search**, with live access enabled. It can search, follow results and reformulate within that tool. Instructions require fresh checks for changing facts, primary pricing/release sources, every entity in a shortlist, matching currency/tier/billing/region, and event dates rather than publication dates. The answer must distinguish an actual vendor change, an old mistake, and insufficient historical evidence. Missing or ambiguous history calls for a specific question. Search use and claim support still depend on model judgment; a citation is provenance, not a truth guarantee.

## Why this shape

Plain Node HTTP, built-in SQLite, browser JavaScript, and three runtime dependencies make the important code easy to inspect. GPT-6.1 Sol with low reasoning effort is the configurable answer default; the smaller memory model runs only on long histories. Native search avoids another key, custom crawler and SSRF surface. Tokens stream immediately; citations are finalized from provider annotations, not invented URLs. The evidence drawer exposes recall, searches, sources and measured timings without exposing hidden reasoning.

Runs have a 120-second deadline and 12-tool-call budget. Stop/disconnect aborts upstream work. Only complete answers become historical evidence; failures remain visible, and startup recovers interrupted runs. SQLite transactions protect imports. Sanitized Markdown, CSP, same-origin/Host checks and loopback binding protect the local reviewer app. Provider storage is disabled, but relevant history is transmitted to OpenAI. This is not a public multi-user deployment.

## Rejected and next

I rejected an agent framework, multiple debating agents, a vector database, lossy summaries, stale answer caches and a second search provider: each adds failure modes before it addresses the central temporal problem. Local contract tests exercise dates, recall budgets, isolation, persistence, streaming and failures; they do not measure model quality. A separately invoked live evaluation records full answers, evidence, token counts and latency for manual grading. It was **not run**, because no API key was supplied and live testing was declined.

With another week: measure temporal-answer accuracy and p50/p95 latency; build a dated, adversarial regression set with human claim-support grading; add semantic recall beyond 800 candidates; retain permitted page excerpts for stronger baselines; and add authenticated HTTPS deployment with durable backups and quotas. I would choose further complexity from those measurements.
