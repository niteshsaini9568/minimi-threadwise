# Threadwise

A chat agent with one tool, **web search**, and a durable record of what you asked and when. Built for the minimi hiring challenge.

The interface uses a dark olive palette, a central composer, prompt cards and an on-demand history drawer. Inter Variable is served locally, matching the supplied MantriAI website's typography; its license is included in `public/fonts/`.

Read [DESIGN.md](DESIGN.md) for the architecture and tradeoffs.

## Run

Requires **Node.js 24+**. SQLite is built into Node; no database service or Docker is needed.

```sh
npm install
```

Copy `.env.example` to `.env`, then set `OPENAI_API_KEY`. This is the **only required API key**. The OpenAI project needs API billing, Responses API access, and access to the configured models and built-in web search. A ChatGPT subscription alone is not an API key.

```sh
# Windows PowerShell
Copy-Item .env.example .env
# macOS / Linux
cp .env.example .env
```

Run only the copy command for your OS. Then:

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000). Without a key, the interface and history controls work; chat shows a clear setup message. There is no simulated answer mode. Restart after editing `.env`. `npm start` runs without watch mode.

`OPENAI_MODEL` defaults to `gpt-6.1-sol`; `MEMORY_MODEL` defaults to `gpt-6-luna` and runs only for long histories. Change them if your API project has different model access. See the [official model catalog](https://developers.openai.com/api/docs/models) and [web-search API guide](https://developers.openai.com/api/docs/guides/tools-web-search) for supported models and tool behavior.

## Try the challenge

Start a normal conversation and later ask what changed. Memory spans conversations in the same browser profile, survives refresh/server restart, and includes original answers and citations.

To try historical dates immediately, open **History**, click **Try the sample conversations**, then **Import history**, and choose that JSON. All sample answers are visibly marked as unverified imports. They contain no fabricated numerical pricing baseline. On 11 November 2026, the three suggestion cards align with those dates. On other days, ask explicitly:

- “On 9 November 2026 we shortlisted five CRM tools. Has pricing or anything significant changed since?”
- “What did I ask on 3 November 2026? Is your answer still correct today?”
- “On 10 November 2026 I asked about Postgres hosting. Has pricing changed since?”

With no matching history, the agent should ask for the missing baseline. With no historical price quote, it should distinguish today's price from an unproven change. A polished answer claiming otherwise is a failure, even if the current price is right.

Each answer has an evidence drawer showing sources, retrieval times, included conversation turns, calendar assumptions, searches, model usage and measured latency. **Included turns are context, not a claim that the model used every turn.** A retrieval timestamp is not a publication date.

Enter sends; Shift+Enter adds a line. Stop cancels the request. Failed/partial answers are visible but are not reused as completed evidence. You can export completed text history or delete a conversation. Exports deliberately omit search traces, annotations and failed turns; reimports are marked unverified. JSON import limits: 1 MB, 50 conversations, 1,000 turns, past timestamps with offsets and valid IANA timezones. See [the sample schema](fixtures/sample-history.json).

## Verification

```sh
npm test
npm audit --omit=dev
```

Offline tests exercise real HTTP/SSE and SQLite, with a mock model transport. They cover exact-date/relative-date recall, timezone/DST/year boundaries, context limits, interrupted runs, isolation, transactional imports, unsafe source URLs and provider failures. They cannot establish answer quality or real provider compatibility.

```sh
# Optional, paid live evaluation; requires OPENAI_API_KEY.
npm run eval
```

This executes the prompts in [eval-cases.json](fixtures/eval-cases.json), saves an ignored `eval-results-*.json`, and records answers, citations, searches, context, usage, first-token latency and total latency. Grade using each case's acceptance criteria; it does not invent an automatic quality score. Live evaluation was not run during delivery, at the user's request.

## Code map

| File | Responsibility |
| --- | --- |
| `src/server.js` | HTTP routes, browser identity, trust boundaries, SSE, cancellation |
| `src/store.js` | Durable turns, ownership filtering, recovery, import transactions |
| `src/memory.js` | User-local calendar dates, bounded exact context and candidate ranking |
| `src/agent.js` | Answer policy, optional structured recall, sole web-search tool, evidence |
| `public/` | Accessible chat, safe Markdown/citations, history controls |
| `test/` | Offline behavioral and integration tests |
| `scripts/eval.js` | Explicitly invoked live research evaluation |

## Boundaries

- The server binds to `127.0.0.1`. It is a local reviewer app; do not expose it publicly without authentication, HTTPS, quotas, and backups. Public GitHub source does not imply a publicly hosted chat service.
- Memory is scoped by a random HttpOnly, SameSite cookie. Another profile/incognito session gets separate history. Clearing that cookie loses browser access to the old history. Export first if you need portability.
- SQLite data lives in ignored `data/`. `.env` is ignored. Raw history and API keys are never committed. Local storage is not encrypted; anyone with access to your device files can inspect it.
- Relevant history goes to OpenAI to answer a question. `store: false` disables Responses storage; it is not a promise of zero provider retention. The model is instructed to search only public entities and minimum relevant dates, not private conversation text. That instruction is not a formal data-loss-prevention guarantee.
- English date hints support named weekdays, today/yesterday, ISO dates and named months. Other languages and ambiguous numeric dates rely on model interpretation/clarification. The convention for “last Tuesday” is disclosed in the answer policy.
- Large-history retrieval can miss paraphrases, records outside the 800-candidate index, or whole turns too large for the 80,000-character budget. Omission counts are shown. These are character bounds, not exact token counts.
- Web access, search selection, effective dates and citation support depend on the provider and model. The app records what happened; it does not claim perfect recall, guaranteed fact checking or benchmark parity with leading products.

Submission: publish this repository publicly, then send its URL through the [application form](https://binary.so/YIrD8L5).
