# Preferred-guide RAG tuning roadmap

**Status:** Research complete (July 2026) — not implemented  
**Audience:** Future agents and maintainers planning RAG quality work  
**Last updated:** 2026-07-22  
**Related:** [preferred-guide.md](../preferred-guide.md), [embedding-models.md](../embedding-models.md), `lib/guide-rag.ts`, `lib/chunk-guide.js`

## Purpose

Capture research-backed recommendations for preferred-guide RAG quality:
chunk size, retrieval count (`RETRIEVE_K`), similarity gate (`GUIDE_HIT`), and
whether to add learned routers vs off-the-shelf rerankers. Use this doc when
scoping the next RAG update; it does **not** change runtime behaviour.

---

## Current baseline (shipped)

| Knob | Location | Value | Notes |
|------|----------|-------|-------|
| Chunk target | `lib/chunk-guide.js` `TARGET_CHARS` | ~500 tokens (~2000 chars) | Structure-aware split (headings, rules, paragraphs) |
| Overlap | `lib/chunk-guide.js` `OVERLAP_CHARS` | ~15% of chunk | Overlap tail on boundary flush |
| Retrieve K | `lib/guide-rag.ts` `RETRIEVE_K` | 5 | Per-guide filter first, then exact cosine sort |
| Hit threshold | `lib/guide-rag.ts` `GUIDE_HIT` | 0.35 | Hand-tuned; skip Tavily when `topSimilarity >= GUIDE_HIT` |
| Embed model | `lib/embed.ts` | `text-embedding-3-large` @ 1024-dim | Sumopod OpenAI-compatible API |
| Router | — | Cosine threshold only | No cross-encoder, no hybrid BM25, no learned router |
| Corpus scale | `match_guide_chunks` RPC | Tens of chunks per guide URL/bundle | Not million-doc ANN search |

**On RAG hit:** up to 5 chunks (~2.5k tokens of guide text) marked `preferred: true`;
tiered web search is skipped.

**On RAG miss:** top 1 chunk kept as weak hint + Tavily/Serper fallback.

**Calibration:** `RAG_DEBUG=1` logs `[rag-calibrate] hit=… top=… scores=[…]` per query
(see [embedding-models.md](../embedding-models.md) migration checklist).

---

## Game-guide query profile

Player questions fall into two patterns; chunk/K tuning should be judged on both:

| Pattern | Example | Retrieval need |
|---------|---------|----------------|
| **Lookup** | "Where is the fire flower?" | High precision, smaller effective chunks help |
| **Procedural** | "How do I beat Ganon phase 2?" | Local step context; 400–512 token chunks |

Sources are semi-structured walkthroughs (GameFAQs headings, numbered sections).
The existing structure-aware chunker matches this better than naive fixed-token splits.

---

## Research summary (2025–2026)

Condensed from industry playbooks and papers; not gospel — **evaluate on your traces**.

### Chunk size

- **Default band:** 384–512 tokens for technical docs and walkthroughs.
- **Smaller (128–256):** better for factoid/FAQ lookup; can break multi-step procedures.
- **Larger (512–1024):** better when answers need narrative context across sentences.
- **Overlap:** mixed results. One systematic study found overlap often adds indexing
  cost without measurable QA gain; game guides with hard section boundaries may still
  benefit from ~10–15% overlap at step boundaries.
- **Context cliff:** retrieved context quality can degrade when total injected context
  grows large (~2.5k+ tokens in some studies). Relevant because `RETRIEVE_K=5` ×
  ~500 tokens ≈ 2.5k on a full hit.

**Sources:**

- [RAG Chunking Strategies: 2026 Retrieval Playbook](https://www.digitalapplied.com/blog/rag-chunking-strategies-2026-retrieval-quality-playbook)
- [A Systematic Analysis of Chunking Strategies for Reliable QA (arxiv)](https://arxiv.org/html/2601.14123v1)
- [Rethinking Chunk Size for Long-Document Retrieval (arxiv)](https://arxiv.org/pdf/2505.21700)
- [Optimizing RAG Chunk Size (ML+)](https://machinelearningplus.com/gen-ai/optimizing-rag-chunk-size-your-definitive-guide-to-better-retrieval-accuracy/)

### Retrieval count (K)

- **Small per-corpus retrieval (this app):** sending **3–5** chunks to the LLM is
  standard when the candidate set is already filtered to one guide (~dozens of rows).
- **Two-stage pattern:** retrieve **15–20** candidates, **rerank to 3–5** for the
  LLM when using a cross-encoder. Overfetch only pays off with a second-stage ranker.
- Raising K without reranking mostly adds duplicate/overlapping sections, not recall,
  because `guide_url` / `guide_bundle` btree filter already shrinks the search space.

### Similarity threshold vs reranking

- **Bi-encoder cosine** (current): fast, good for recall within a small guide set.
  Absolute thresholds (like `GUIDE_HIT`) are **model- and corpus-specific**; there is
  no universal constant for `text-embedding-3-large`.
- **Industry trend:** prefer **top-k ranking** or a **cross-encoder reranker** over a
  hard cosine cutoff for deciding relevance.
- **Cross-encoder rerankers** (Cohere Rerank API, `ms-marco-MiniLM`, etc.): typical
  +10–25% precision on reranked candidates; ~100–200ms for ~50 pairs on CPU. Use
  **after** vector retrieval, not instead of it.

**Sources:**

- [Cross-Encoder Reranking in Practice](https://tianpan.co/blog/2026-04-19-cross-encoder-reranking-cosine-similarity)
- [Advanced RAG: Cross-Encoders & Reranking (TDS)](https://towardsdatascience.com/advanced-rag-retrieval-cross-encoders-reranking/)
- [Reranking for RAG guide (Ailog)](https://app.ailog.fr/en/blog/guides/reranking)

### Learned routers (RAGRouter, LTRR, etc.)

- **Learned query routers** pick among multiple retrievers or LLM backends. Useful
  when you have **several retrieval strategies** or models with different strengths.
- **Not recommended now:** GameGuideGo has one bi-encoder path + web fallback. A
  trained router adds labeling, retraining, and ops without solving the main failure
  mode (wrong chunk ranked high within the same guide).

**Sources:**

- [RAGRouter (arxiv)](https://arxiv.org/pdf/2505.23052)
- [LTRR: Learning To Rank Retrievers (arxiv)](https://arxiv.org/html/2506.13743v1)

---

## Verdict for GameGuideGo

### Keep as-is for now (low risk)

| Setting | Recommendation |
|---------|----------------|
| Chunk size | **~400–512 tokens** — current ~500 is appropriate |
| Splitting | **Structure-aware** (`chunk-guide.js`) — keep |
| Overlap | **10–15%** — keep unless eval shows boundary noise |
| `RETRIEVE_K` | **5** (try **3** if answers feel bloated or noisy) |

### Calibrate, don't guess

| Setting | Recommendation |
|---------|----------------|
| `GUIDE_HIT` | **Must be calibrated on real traces** with `RAG_DEBUG=1`. Expect a band
  roughly **0.30–0.45** for bi-encoders, but only your score clusters matter. |

### Best next upgrade (highest ROI)

**Do not** build a custom trained router yet.

**Do** consider, in order:

1. **Cross-encoder rerank** — `match_guide_chunks` with `LIMIT 15–20`, rerank to
   top 3–5, route on reranker score (soften or replace `GUIDE_HIT`).
2. **Hybrid BM25 + vector** — helps boss names, item IDs, acronyms embeddings miss.
3. **Parent–child chunks** — small children for retrieval, larger parent context for
   Gemini (best long-term fit for walkthroughs; more engineering than a knob tweak).

### Do not prioritize yet

- Fine-tuned embedding model on game guides
- Full learned RAGRouter-style routing
- Semantic chunking at ingest (cost/latency; structure-aware split is good enough)
- Raising `RETRIEVE_K` above 5 without a reranker

---

## `GUIDE_HIT` calibration procedure

Use before changing the constant or removing it.

1. Set `RAG_DEBUG=1` in `.env.local`, run `npm run dev`.
2. Ingest one guide you know well (single page + one multi-page bundle if possible).
3. Ask **~10 in-guide** questions (clearly covered by the pasted guide).
4. Ask **~10 off-guide** questions (different game, vague, or unrelated topic).
5. Read `[rag-calibrate] hit=… top=… scores=[…] top_chunk=…` in the server log.
6. Identify two clusters: relevant (high) vs irrelevant (low).
7. Set `GUIDE_HIT` **between** the clusters (or plan reranker migration if clusters overlap).
8. Re-run a subset to confirm hit/miss matches intent.
9. Unset `RAG_DEBUG` when done (harmless to leave on in dev).

**Failure modes to watch:**

| Symptom | Likely cause | Knob / fix |
|---------|--------------|------------|
| Answers ignore guide despite paste | `GUIDE_HIT` too low, or wrong chunk at rank 1 | Raise threshold or add reranker |
| Web search skipped but answer wrong | `GUIDE_HIT` too high, or wrong-game guide | Lower threshold; reranker margin check |
| Right section, wrong steps | Chunk boundary split a procedure | Overlap or parent–child chunks |
| Misses exact item/boss name | Embedding-only retrieval | Hybrid BM25 |
| Same-series wrong game guide wins | Similar embedding scores | Reranker + prompt guardrails (existing) |

---

## Proposed phased plan (future PRs)

Use as a starting backlog; each phase should pass `npm run check` and include
before/after notes from the calibration set.

### Phase A — Measure (no behaviour change)

- [ ] Build a fixed eval set: 20–30 `(game, guide_url, question, expected: in-guide | off-guide)` rows.
- [ ] Log `topSimilarity`, `scores[]`, `hit`, `pipelineType` per row with `RAG_DEBUG`.
- [ ] Document baseline hit rate and answer quality (manual spot-check).

### Phase B — Tune constants

- [ ] Set `GUIDE_HIT` from Phase A clusters.
- [ ] A/B `RETRIEVE_K` 3 vs 5 on eval set (quality + token cost).
- [ ] Update `GUIDE_HIT` comment in `lib/guide-rag.ts` with calibration date and model.

### Phase C — Cross-encoder rerank (recommended upgrade)

- [ ] Raise SQL/RPC retrieve limit (e.g. 15–20) within same `guide_url` filter.
- [ ] Add reranker (Cohere Rerank API or self-hosted `ms-marco-MiniLM-L-6-v2`).
- [ ] Replace or supplement `GUIDE_HIT` with reranker top-1 score + margin to #2.
- [ ] Keep `RETRIEVE_K` sent to Gemini at 3–5 post-rerank.

### Phase D — Hybrid retrieval (optional)

- [ ] Add BM25 (or Postgres `tsvector`) on `chunk_text` scoped to `guide_url`.
- [ ] Merge vector + keyword hits (RRF or simple union) before rerank.

### Phase E — Parent–child chunks (optional, larger)

- [ ] Index small child chunks; store parent section text or parent chunk id.
- [ ] Retrieve children, inject parent context into `buildPrompt` sources.

---

## Cost / latency notes

| Path | Cost | Latency |
|------|------|---------|
| Current hit (5 chunks, no Tavily) | ~2.5k guide tokens + 2 Gemini calls | Lowest search cost |
| Current miss | Embed query + 1 chunk + up to 4 Tavily calls | Higher |
| + Reranker | +1 rerank API call on 15–20 pairs (~100–200ms) | Small add |
| + Higher K without rerank | More guide tokens to Gemini | Usually worse quality/$ |

`RETRIEVE_K` and chunk size directly cap guide tokens on hit. See cost ceiling
notes in `CLAUDE.md` (preferred-guide RAG section).

---

## Files to touch (when implementing)

| Phase | Files |
|-------|-------|
| B | `lib/guide-rag.ts` (`GUIDE_HIT`, `RETRIEVE_K`) |
| C | `lib/guide-rag.ts`, new `lib/guide-rerank.ts` (or provider adapter), `db/guide-chunks.sql` RPC limit |
| D | `db/guide-chunks.sql` (tsvector index?), `lib/guide-rag.ts` |
| E | `lib/chunk-guide.js`, `lib/guide-ingest.ts`, `guide_chunks` schema, `match_guide_chunks` |

---

## See also

- [preferred-guide.md](../preferred-guide.md) — shipped architecture and deferred ledger
- [embedding-models.md](../embedding-models.md) — model swap + `GUIDE_HIT` recalibration
- `CLAUDE.md` — runtime contract (`GUIDE_HIT`, ingest, bundle behaviour)
