# Embedding fallback via Replicate

**Status: Phase 1 SHIPPED (issue #5, PR #7). Phase 2 (lazy re-embed) SHIPPED (issue #9).**
Decision recorded 2026-10-28; model chosen and research findings added 2026-10-29.

## Problem

Preferred-guide ingest and per-turn RAG query embedding depend on one provider,
Sumopod (`text-embedding-3-large`, 1024-dim, `lib/embed.ts`). When Sumopod credit
runs out, new guides cannot be indexed and RAG queries cannot be embedded. There
is no backup. (Tavily Extract was checked on 2026-10-28 and is healthy; this plan
is embedding only. Extract has no fallback either, tracked separately in
`CLAUDE.md` Known limits.)

## Decision

**Option 2: two embedding models side by side.** Sumopod stays primary. When it
fails (credit exhausted, 401/402/429, network), fall back to a Replicate-hosted
embedding model. Rejected: option 1 (replace Sumopod entirely, re-embed every
guide), which is simpler but leaves no primary/backup split.

## Chosen model (researched 2026-10-29)

`text-embedding-3-large` is **not** on Replicate (`replicate.com/openai/text-embedding-3-large`
returns 404; only `openai/clip` exists), so the fallback is a different model.

- **Primary fallback:** `lucataco/qwen3-embedding-8b`, pinned to version
  `42d968487820032a1535d81ea20df16f442ea308ec5abae6b5d6cf4675eb3e2f` (short
  `42d9684`; hash read from the Replicate API `latest_version.id`).
  - Input `text` is a REAL `string[]` (not a JSON-encoded string), `embedding_dim: 1024`,
    `normalize: true`, `batch_size` about 16. Vectors come back at `output.embeddings`.
  - Queries pass `instruction` formatted `Instruct: <task>\nQuery:`; documents get none.
- **Backup:** `saattrupdan/multilingual-e5-large-instruct` (native 1024-dim, 512-token cap).
- **Wrapper caveat:** the Replicate wrapper mean-pools tokens while the official
  model uses the last token, so published MTEB numbers may not transfer. It must
  pass `scripts/test-hybrid-retrieval.mjs` and `docs/plan/rag-eval-set.jsonl` before
  it is trusted.
- **Cold starts:** community embedders on Replicate have been seen at 96 to 274s.
  A Deployment with keep-warm costs about $2.5k/month and is rejected. Ingest path:
  long timeout. Query path: fail fast to lexical-only.

## Core constraint

Vectors from different models are **not comparable**. A query embedded with model
B cannot search chunks embedded with model A (retrieval degrades silently, no
error). So every stored chunk must record which model produced it, and a query
must be embedded with the same model as the chunks it searches.

## Design

1. **Schema** (`db/` migration): add `guide_chunks.embed_model text not null
   default 'sumopod'`. Existing rows backfill to `sumopod` via the default, so
   **no re-embed of existing guides**. Keep 1024 dims with one `vector(1024)`
   column (Qwen is called with `embedding_dim: 1024`); no second vector column.
   The value names model and version, e.g. `replicate:qwen3-embedding-8b@42d9684`
   (Sumopod rows keep `sumopod`). Do NOT add an ANN index (see CLAUDE.md rule on `guide_chunks.embedding`).
2. **Provider layer** (`lib/embed.ts`): `embedTexts` / `embedQuery` try Sumopod,
   catch provider errors, retry on Replicate, and return `{ vectors, model }`.
   Add query vs document instruction handling (`Instruct: <task>\nQuery:` for
   queries, none for documents); Sumopod ignores it.
   Trace events: extend `embed_texts_*` / `embed_query_*` with `model` and a
   `embed_fallback` event.
3. **Ingest** (`lib/guide-ingest.ts`): store `embed_model` on each chunk row. A
   guide is indexed entirely with one model (never mix within one guide URL).
4. **Retrieval** (`lib/guide-rag.ts` + `match_guide_chunks_hybrid`): look up the
   model a guide was indexed with, embed the query with that model, pass
   `p_embed_model` to the RPC so only same-model vectors are compared.
   If that model is currently unavailable (e.g. old Sumopod guide while Sumopod is
   down): **lexical-only retrieval** via `chunk_tsv` (already in the hybrid RPC),
   else fall through to tiered web search. Never compare cross-model vectors.
5. **Cache** (`lib/embed-cache.ts`, `public.embed_cache`): include the model tag in
   the cache key. It is already prefixed with the `EMBED_MODEL` env value but not
   the provider, so the provider/version tag is still needed.
6. **UI**: if both providers fail, toast "Indexing paused, try again later" and
   keep the retry affordance on the guide row (`use-guide-bundle.tsx`). Ingest is
   lazy, so this is recoverable.

## Other 1024-dim consumers (gap)

Two more tables are `vector(1024)` and fed by `lib/embed.ts`, so they need the same
model tag and the same no-cross-model rule:

- `public.player_journal_chunks` (`db/player-journal-chunks.sql`), embedded in
  `lib/player-journey-server.ts`, queried in `lib/player-journey-rag.ts`.
- `public.embed_cache` (`db/embed-cache.sql`).

## Behaviour while Sumopod is down

| Guide | Query path |
|-------|-----------|
| Indexed with Sumopod (old) | lexical-only, then web search. Normal retrieval resumes the moment credit returns |
| New guide indexed during outage | Qwen vectors, full hybrid retrieval |
| Guide indexed with Replicate, Sumopod back | stays on Replicate forever (query embedded with Qwen); no auto-migration |
| New guide indexed after recovery | Sumopod again |

Decision (user, 2026-10-29): Sumopod-indexed guides use lexical-only retrieval, then
web search, while Sumopod is down. Lazy re-embed of stored chunk text to Qwen is a
**Phase 2 follow-up**, now shipped:

**Phase 2 SHIPPED (issue #9): lazy re-embed.** `lib/guide-reembed.ts` (I/O) +
`lib/guide-reembed-rules.js` (pure rules, `npm run check`) + `db/embed-reembed.sql`. When a queried
guide is tagged `sumopod`, Sumopod is unavailable and Qwen is available, `retrieveFromPreferredGuides`
answers lexical-only as before and starts a background conversion (`after()`, in-instance
`singleFlight`). It re-embeds the stored `chunk_text` (same `section breadcrumb + text` input as
ingest) with `QWEN_MODEL_TAG` into STAGING columns `embedding_next` / `embed_model_next`
(`stage_guide_embeddings`, 25 rows per call, highest `chunk_index` first, only rows with
`embedding_next is null`, so kill/timeout/new query resumes). The live `embedding`/`embed_model` are
untouched until `flip_guide_embeddings` swaps ALL rows of the guide in one transaction, and refuses
(returns 0) unless every row is on the old model and fully staged: no mixed tags, never half converted,
chunk 0 present throughout. Run budget min(200s, 300s - request elapsed - 45s), threaded from the request start (`requestStartMs`), checked before claiming and between 16-row batches (stops under 30s left, next query resumes).
Spend guards persist in `guide_reembed_runs` via `claim_guide_reembed`: 6 min per-guide cooldown (any
run, longer than the max run), 3 failed or killed runs per guide per 24h then `failing` refusal, 2 concurrent,
30 runs per 24h globally. All four functions are `service_role` execute only.
Fails open (trace `reembed_skip`: `no_service_key`, `sql_missing`, `claim_error`, `no_time`, `cooldown`, `failing`, `busy`, `cap`). A missing-SQL result is cached for 10 min.
Journal chunks are excluded: the journal is deleted and fully re-embedded on every update
(`lib/player-journey-server.ts`), so it self-heals on the next update.
Rollback: aborting before the flip loses nothing; after it the Sumopod vectors are overwritten
(Sumopod has no credit to regenerate them, and no `embedding_prev` is kept). Code rollback = revert the
PR, flipped guides stay valid because retrieval already supports the Qwen tag.

## Caveats

- Replicate community embedders have cold-started at 96 to 274s (see Chosen model).
  Acceptable for a fallback, poor as the primary path. (The 96s gap seen in traces
  came from the Sumopod path, not Replicate.)
- Replicate credit also pays for Gemini (`resolveQuestion`, `summarize`). If
  Replicate credit is the one exhausted, this fallback adds no resilience.
- Quality of the Qwen wrapper is unproven here. Gate it on
  `scripts/test-hybrid-retrieval.mjs` and the RAG eval set
  (`docs/plan/rag-eval-set.jsonl`) before shipping.

## Shipped (Phase 1)

Ingest crash-safe (Phase 1): embeds finish before any DB write; batches of 25 rows insert in
reverse order so chunk 0 lands last, and "indexed" means chunk 0 exists, so a killed run is
re-ingested instead of staying half-indexed. Leftover rows of an unindexed guide are deleted
with the service-role client (`SUPABASE_SERVICE_ROLE_KEY`, server-only) and verified by recount
before any extract/embed spend; read errors, a missing key or rows that will not delete skip
the spend (`embedFailed`, "Indexing paused"). A flagged (stale/insufficient) index is replaced
only after the new embeds exist (replace-on-success) and keeps serving if the replace cannot
run. Concurrent ingests of one URL share a run per instance (`singleFlight`).

## Known limits

- L26: a Replicate outage re-extracts a new guide every turn (no negative cache). A 5-minute
  negative cache is the upgrade path; low value because Gemini shares Replicate.
- L21 (pre-existing, separate follow-up issue): `app/api/guide-upload/route.ts` user DELETE uses
  the anon client (removes 0 rows under RLS) and takes `userId` from the body unauthenticated.
  Fix: verify the bearer token, then delete with the service client. Fixed in #8 (PR #10).
- Cross-instance concurrent ingest can still duplicate work (lease table is the upgrade path).

## Open items

- Model decided: Qwen3-Embedding-8B pinned above (BGE builds are English-only or
  cold, nomic is 768-dim). Remaining: run the eval gate on the wrapper.
- Phase 2: shipped, see above.
- Update `CLAUDE.md` (`lib/embed.ts` entry, Environment, Known limits) and
  `docs/embedding-models.md` when shipped.
