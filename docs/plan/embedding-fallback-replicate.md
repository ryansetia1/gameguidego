# Embedding fallback via Replicate

**Status: Planned (not started).** Decision recorded 2026-10-28; implement later.

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

## Core constraint

Vectors from different models are **not comparable**. A query embedded with model
B cannot search chunks embedded with model A (retrieval degrades silently, no
error). So every stored chunk must record which model produced it, and a query
must be embedded with the same model as the chunks it searches.

## Design

1. **Schema** (`db/` migration): add `guide_chunks.embed_model text not null
   default 'sumopod'`. Existing rows backfill to `sumopod` via the default, so
   **no re-embed of existing guides**. Keep 1024 dims: pick a Replicate model
   that supports a 1024 output, or add a second vector column if it cannot.
   Do NOT add an ANN index (see CLAUDE.md rule on `guide_chunks.embedding`).
2. **Provider layer** (`lib/embed.ts`): `embedTexts` / `embedQuery` try Sumopod,
   catch provider errors, retry on Replicate, and return `{ vectors, model }`.
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
5. **Cache** (`lib/embed-cache.ts`, `public.embed_cache`): include the model in
   the cache key.
6. **UI**: if both providers fail, toast "Indexing paused, try again later" and
   keep the retry affordance on the guide row (`use-guide-bundle.tsx`). Ingest is
   lazy, so this is recoverable.

## Behaviour while Sumopod is down

| Guide | Query path |
|-------|-----------|
| Indexed with Sumopod (old) | lexical-only, then web search. Weaker until credit is topped up |
| New guide indexed during outage | Replicate vectors, full hybrid retrieval |
| Guide indexed with Replicate, Sumopod back | still Replicate (query embedded with Replicate); no auto-migration |

## Caveats

- Replicate cold starts have produced very slow embeds before (a 96s gap seen in
  traces). Acceptable for a fallback, poor as the primary path.
- Replicate credit also pays for Gemini (`resolveQuestion`, `summarize`). If
  Replicate credit is the one exhausted, this fallback adds no resilience.
- Quality of the Replicate model is unproven here. Gate the model choice on
  `scripts/test-hybrid-retrieval.mjs` and the RAG eval set
  (`docs/plan/rag-eval-set.jsonl`) before shipping.

## Open items before implementing

- Pick the Replicate embedding model (BGE / nomic / other) and confirm 1024-dim.
- Decide whether to add an optional background "re-embed to primary" job once
  Sumopod returns (default: no, YAGNI).
- Update `CLAUDE.md` (`lib/embed.ts` entry, Environment, Known limits) and
  `docs/embedding-models.md` when shipped.
