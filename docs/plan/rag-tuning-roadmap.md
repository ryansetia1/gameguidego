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

## Calibration results (2026-07-22)

First real run via `npm run eval:rag` — Suikoden 1 single-page guide, 6 in-guide +
4 off-guide, questions in casual Indonesian (real user distribution).

| Signal | Result | Read |
|--------|--------|------|
| in-guide top-sim | 0.28–0.42 (median 0.39) | Low + compressed (cross-lingual: ID question vs EN guide) |
| off-guide top-sim | 0.03–0.09, except one game-topic Q at **0.348** | Non-game separates cleanly; same-domain wrong-game does not |
| `GUIDE_HIT` ceiling | ~90% at any single cutoff | Threshold is **not** the lever; overlap is structural |
| Retrieval recall@5 | **6/6 in top-K** | Right paragraph is always retrieved |
| Retrieval rank-1 | **3/6** | …just mis-ordered (misses at rank 2–4) |

**Conclusion:** recall is solved (100% @ K=5); the failure is **ranking + routing**.
This is the textbook cross-encoder rerank case:

- **Phase C (rerank) is the fix, and likely sufficient.** Reranking the already-retrieved
  top-K pushes the right chunk to rank 1 AND gives a relevance score that can reject the
  same-domain wrong-game query (0.348) that a raw cosine cutoff can't.
- **Phase D (hybrid BM25) downgraded.** Earlier hypothesis was that exact names
  ("Sylvina", "Armor Shop") were missed by embeddings — the data disproves it: they're
  in top-K (rank 3–4), just not rank 1. Rerank handles ranking; BM25 only worth it if a
  later eval shows recall misses (paragraph absent from top-K).
- **Phase E (parent–child) not indicated** — no "right section, wrong steps" symptom seen.

**Caveats:** small sample (n=10), one guide, one language. Re-run on 2–3 guides before
treating the `GUIDE_HIT` ceiling as final. Since recall@5 = 100%, a v1 reranker can
score the existing top-5 — no need to raise the SQL `LIMIT` to 15–20 yet.

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

### Phase A — Measure (no behaviour change) — HARNESS SHIPPED

Tooling landed (2026-07-22); the eval run itself still needs to be done by a
maintainer with the guides ingested:

- [x] Dev-only probe `app/api/rag-eval/route.ts` — returns raw top-K similarity
  scores for one `(guideUrls, query)` pair (404 in prod). Adds `scores?: number[]`
  to `GuideRagResult` in `lib/guide-rag.ts`.
- [x] Replay harness `scripts/rag-calibrate.mjs` (`npm run eval:rag`) — splits
  in-guide vs off-guide clusters, recommends `GUIDE_HIT`, reports per-rank score
  decay for `RETRIEVE_K`. Self-check: `node scripts/rag-calibrate.mjs --selftest`.
- [x] Eval-set template `docs/plan/rag-eval-set.example.jsonl` (real set is
  gitignored — may hold private guide URLs).
- [ ] **Run it:** fill `docs/plan/rag-eval-set.jsonl` with 10+ in-guide + 10+
  off-guide rows for guides you ingested, then `npm run eval:rag`.

### Phase B — Tune constants (needs the Phase A run) — DONE

- [x] Ran calibration; `GUIDE_HIT` kept at 0.35 (data showed threshold is not the
  lever — see Calibration results above).
- [x] `RETRIEVE_K` kept at 5 (targeted paragraph often ranks 2–3; overfetch helps
  until rerank lands).
- [x] Updated the `GUIDE_HIT` + `RETRIEVE_K` comments in `lib/guide-rag.ts` with
  the calibration date and reasoning.

### Phase C — Rerank (DONE 2026-07-22: Cohere, opt-in)

Final state: **cosine is the default (free); Cohere rerank-v3.5 is the proven
upgrade, gated on `COHERE_API_KEY` presence.** The Gemini LLM-reranker that was
tried first is deleted — it regressed vs cosine.

3-way A/B on the calibration set (`RAG_EVAL_DELAY_MS=6500` dodges the trial's
10 req/min rate limit):

| Provider | Routing accuracy | Retrieval rank-1 |
|----------|------------------|------------------|
| Cosine (baseline, default) | 9/10 | 3/6 |
| Gemini LLM-rerank (deleted) | 8/10 | 3/6 |
| **Cohere rerank-v3.5** | **10/10** | **6/6** |

Cohere fixed both failure modes: every targeted paragraph moved to rank 1, and its
`relevant` verdict caught the low-cosine in-guide (Valeria) AND rejected the
same-domain wrong-game query (Sephiroth) without dropping any legit in-guide.
`COHERE_RELEVANCE_MIN=0.3` separated cleanly. Gemini 2.5 Flash with
`thinking_budget:0` was a poor reranker (verdict too strict, ordering ≈ cosine).

**Wiring** (`lib/guide-rerank-cohere.ts` + `lib/guide-rag.ts`):

- Enabled purely by `COHERE_API_KEY` being set — no `RERANK_PROVIDER` flag. Unset =
  cosine. Matches "just swap the key" — set a paid key later, no code change.
- Fully **fail-open**: any Cohere error (trial expired, 429 rate-limit, network)
  returns null → cosine `GUIDE_HIT`. Safe to leave enabled on the trial key.
- `COHERE_RELEVANCE_MIN` (default 0.3) routes low-relevance tops to web fallback;
  `COHERE_RERANK_MODEL` (default `rerank-v3.5`).

**Cost note:** trial keys are free but non-commercial + 10 req/min. Fine for
dev/testing; for production, move to a paid Cohere key (1000 req/min) — swap
`COHERE_API_KEY` only.

Recall@5 was already 100%, so the reranker scores the existing top-5 — no SQL
`LIMIT` bump to 15–20 needed. Jina/Voyage would drop in the same way (new adapter
returning `RerankResult`, add a branch in the `guide-rag.ts` gate).

**Correction (2026-08-06, trace `14a03ed6`):** that "score the existing top-5"
decision does not hold once rules rescoring picks the 5. Cohere sees whatever the
heuristics chose out of `RETRIEVE_FETCH = 20`, and on this trace the answer chunk was
not among them — Cohere's top score was 0.342, versus **0.819 / 0.682 with a clear
gap** when handed the full pool of 20. Worse, the rules-after-Cohere pass re-sorted on
cosine, so Cohere's order was thrown away entirely. Ablation on that trace:

| Pipeline | Excerpt sent to summarize |
|----------|---------------------------|
| Current, Cohere on | wrong chunk |
| Current, Cohere off | **byte-identical** wrong chunk |
| Cohere on the pool of 20, rules-after on | still the wrong chunk |
| Cohere on the pool of 20, rules-after off | answer chunk at rank 2 |

So Cohere contributed nothing but the `relevant` verdict. Phase D (hybrid) is what
fixed this turn, and it costs no API call, which is the right place for the load-bearing
signal if the Cohere key ever lapses. If Cohere is re-promoted to own ordering, feed it
the full pool and write its score into `retrieval_score`, or the rules pass will
discard it again.

### Phase D — Hybrid retrieval (SHIPPED 2026-08-06 — the Suikoden caveat bit)

Phase C deferred this because the Suikoden set showed recall@5 = 100%, so exact names
were assumed to be present but mis-ranked. A second guide disproved that. Trace
`14a03ed6` (Link's Awakening GameFAQs `?print=1`, 78 chunks): the player asked what
follows the **Slime Eyes** fight, and the chunk holding that answer sat at **cosine
rank 16 of 20**, below the top-K cut. The 20 nearest chunks spanned 0.650–0.752, a
0.10 band that is noise. The model got one wrong excerpt and invented a next dungeon.

| Retrieval | Rank of the answer chunk |
|-----------|--------------------------|
| Cosine only (shipped before) | 16 of 20 |
| Full-text, bag of every query word | 5 |
| Phrase `slime <-> eye` | **1, and the only match at all** (0.099 vs 0.000) |
| Vector ∪ phrase, fused | **2** |

Bag-of-words is not the lever, the **phrase** is: it isolated the right chunk and
still scored 0 on the chunk describing *Slime Eel*, a different boss that cosine
ranked 2nd. Generic words dilute the signal, so extraction targets proper nouns only.

- [x] Postgres `tsvector` phrase search on `chunk_text` scoped to `guide_url`
  (`db/guide-chunks-hybrid.sql`, `match_guide_chunks_hybrid`).
- [x] Union vector + lexical hits; every row keeps its true cosine plus `lexical_rank`.
- [x] `lib/guide-lexical.js` — proper-noun extraction from the English rewrite using
  capitalisation and sentence position only. No per-game vocabulary; `npm run check`
  asserts it on three unrelated titles.
- [x] Fuse via `retrieval_score = cosine + 0.25` on a lexical hit. The bonus exceeds
  the largest single rescore penalty (0.18) so an exact-name match survives one
  misfiring rule, and two rules together can still override it.

**Structural fix that came with it:** `rescoreGuideChunks` used to rank on
`similarity + delta`, where `similarity` was always raw cosine. That silently
discarded **every** upstream ranking signal, including Cohere's. It now ranks on
`retrieval_score`, so hybrid (and any future reranker) actually survives.

**Rules pruned in the same pass** (`lib/guide-rescore.js`), both of which had actively
pushed the wrong chunk up on this trace:

- `tier_match_boost` **deleted**. It fired on the mere presence of a tier marker on
  both sides, never comparing the number. `tier_mismatch_penalty` is kept.
- `forward_jump_penalty` now yields to `queryLate`, so "after defeating the boss" is
  no longer classified as still-inside-the-dungeon.

Measured on trace `14a03ed6` after every change:

| Path | Rank of the answer chunk |
|------|--------------------------|
| Before any fix | 16 of 20, never reached the model |
| Hybrid, rules unpruned | 2 |
| **Hybrid, rules pruned (shipped)** | **1** |
| Vector-only fallback, rules pruned | 7 |

The fallback row is the honest cost of skipping `db/guide-chunks-hybrid.sql`: pruning
alone lifts the chunk from 16 to 7, but only the lexical hit gets it into the top-5.

#### End-to-end validation, and the bug it caught (2026-08-06)

Offline rank checks said shipped; a live run through `/api/solve` on four unrelated
games said otherwise. `scripts/test-hybrid-retrieval.mjs` asks about a named entity per
game and asserts the excerpt naming it lands in the top 3.

| Guide | Chunks | Before | After |
|-------|--------|--------|-------|
| Link's Awakening (the `14a03ed6` turn) | 78 | rank 2, answer correct | rank 2, answer correct |
| Pokémon Platinum | 1093 | **0 lexical hits** | rank 1, 5 hits |
| Final Fantasy VIII | 781 | rank 1, 11 hits | rank 1, 11 hits |
| Castlevania: SotN | 200 | rank 1, 12 hits | rank 1, 12 hits |

Pokémon Platinum was retrieving on cosine alone while reporting the feature on. The
function built `to_tsvector(chunk_text)` for every scoped row, which at 1093 chunks
exceeded the statement timeout; `fetchCandidates` caught the error and fell back to
`match_guide_chunks` with one `console.warn`. The phrase itself was fine (it matches 5
chunks when run directly), so nothing in the extraction or the trace pointed at the
cause. Fixed by storing the tsvector in a generated `chunk_tsv` column with a GIN index
and marking the `scoped` CTE `not materialized`: **timeout → 30 ms** on that guide.

Lesson worth keeping: a fail-open fallback around a query that can *time out* rather
than merely be *absent* turns a hard failure into a silent one, and it degrades exactly
on the large guides the feature was built for. `lexicalHits: 0` in `rag_db_check` is the
symptom; the server warning is the only place the cause appears.

#### Rank-aware lexical bonus + extraction fixes (2026-08-06)

The flat `+0.25` misread both ends of the range. Reading the final scores of the runs
above: on the Zelda guide the extracted phrases included "Link" and "Cavern", 15 of 34
candidates matched, and an equal bonus on all of them ranked nothing. On the Pokémon
guide only 5 of 24 matched, and there `+0.25` outweighed a 0.23 cosine gap, pushing the
chunk that answers ("beat her → Forest Badge → north → Cynthia → Cut HM") down to rank 4
behind a chunk that merely says her name while describing how to *enter* the gym.

Chasing that exposed two extraction bugs, both of which mattered more than the bonus:

- **A colon was treated as a sentence end.** Guides label areas "Level 3: Key Cavern",
  so "Key" looked sentence-initial and was dropped as grammar, leaving the useless
  "cavern". The single most discriminating phrase in that query was being destroyed.
- **The game's own name was searched for.** "Link" is a real proper noun and appears in
  most chunks of a Link's Awakening guide. Phrases built *only* from title words are now
  dropped (`extractEntityPhrases(text, gameName)`); a phrase that merely contains one
  ("Link's House") is kept.

Rank of the excerpt that actually answers, measured live per config:

| Config | Zelda | Pokémon | FF VIII | SotN |
|--------|-------|---------|---------|------|
| Flat bonus, buggy extraction (first ship) | 2 | 4 | 1 | 1 |
| `1/rank`, buggy extraction | **not retrieved, answer wrong** | 1 | 1 | 1 |
| Flat bonus, fixed extraction | 2 | 4 | 1 | 1 |
| **`1/sqrt(rank)`, fixed extraction (shipped)** | 3 | 2 | 1 | 1 |

`1/rank` overshot: the Zelda answer chunk is only a mediocre name match (lexical rank 9),
so removing its lift dropped it out of the top-5 and the model went back to "the guide
does not cover this" — the original bug, reintroduced by the fix for a different one.
The shipped shape costs Zelda one rank position to buy Pokémon two.

**Harness caveat worth remembering:** the Pokémon case originally asserted only that some
retrieved excerpt said "Gardenia", which the *entering the gym* chunk satisfies, so it
passed while the regression was live. It now asserts on "Forest Badge", which only the
answering chunk contains. An end-to-end test that matches too loosely is worse than none,
because it reports safety it never checked.

The Bottle Grotto suite (`scripts/test-la-turns-1-4.mjs`) stays mixed across runs on the
"did the answer mention X" checks, since each answer picks a different granularity of
next step. The markers that matter are stable: no `forward_jump` on T1/T2 and no
hallucinated Hinox on T3/T4 in either run.

**See also:** [rag-outline-rescore.md](./rag-outline-rescore.md) — planned
game-agnostic outline metadata + rules-based rescoring (Phases 1–3) to improve
rank-1 without requiring Cohere. Partial overlap with Phase D via lightweight
lexical overlap on the over-fetched top-20.

### Phase E — Parent–child chunks (DEFERRED — no symptom observed)

No "right section, wrong steps" failures in calibration. Revisit if procedural
answers start losing multi-step context across chunk boundaries.

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
