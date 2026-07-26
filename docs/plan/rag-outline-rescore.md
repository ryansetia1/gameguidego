# Guide outline metadata + rules-based rescoring

**Status:** Shipped (July 2026)  
**Audience:** Future agents implementing preferred-guide RAG without relying on Cohere  
**Last updated:** 2026-07-26  
**Related:** [rag-tuning-roadmap.md](./rag-tuning-roadmap.md), [preferred-guide.md](../preferred-guide.md), `lib/chunk-guide.js`, `lib/guide-rag.ts`, `lib/guide-ingest.ts`, `lib/prompt.js`

## Purpose

Preferred-guide RAG already has **recall@5 ≈ 100%** on calibration sets; failures are
**ranking and disambiguation** inside the same guide. A live trace showed the model
answering from the wrong walkthrough paragraph even when the correct chunk was in
context:

| Trace | Cohere | Correct chunk rank | Answer |
|-------|--------|-------------------|--------|
| `765789c7` | failed (network) | #5 / 5 | Wrong — "lift large statues" (Level 2 PB, different area) |
| `86e594bb` | ok (0.822) | #2 / 5 | Correct — "lift pots behind chest" |

**Goal:** make cosine + rules-based rescoring + summarize guardrails **decent without
Cohere**. Cohere stays an optional upgrade ([Phase C](./rag-tuning-roadmap.md)); we do
**not** prioritize Cohere retry/backoff.

**Non-goals:**

- Game-specific ontologies (dungeon lists, per-title item tiers, Zelda-only rules)
- Replacing bi-encoder retrieval or raising `RETRIEVE_K` without rescoring
- Mandatory paid reranker dependency

---

## Design principles (all games)

| Do | Don't |
|----|-------|
| Store **document structure** (`section_path`, `chunk_index`) | Hardcode game locations or items |
| Detect headings by **format heuristics** (markdown, rules, numbering) | Assume one author format |
| Rescore with **generic text signals** (progress, tier patterns, overlap) | Branch on franchise name |
| Degrade when outline confidence is low | Fail retrieval when headings are missing |

Every signal must work for GameFAQs walkthroughs, uploaded PDF/TXT/MD, and future
guide sources without code changes per game.

---

## Problem pattern (general)

Player question shape:

> "In **area B**, I just got **reward A** — where next?"

Failure mode:

1. Cosine ranks a chunk that mentions **A** or **B** but from the **wrong progress
   point** (post-area, upgraded variant of A, or a different area with similar steps).
2. Summarize receives **K preferred chunks** all labeled "source of truth" and merges
   steps from incompatible paragraphs.

**Fix stack (implementation order):**

```
Phase 1 — Outline + chunk metadata (ingest)
Phase 2 — Rules-based rescoring (retrieve)
Phase 3 — Summarize contradiction guardrails (generate)
```

---

## Phase 1 — Outline extractor + chunk metadata

### 1.1 New module: `lib/guide-outline.js`

Single responsibility: scan raw guide text once, emit an **outline** and per-line
**active section path** before chunking.

**Heading candidate detectors** (multi-signal, confidence-scored):

| Signal | Example | Notes |
|--------|---------|-------|
| Markdown | `# Bosses`, `## Act 2` | Upload MD |
| Rule underline | line before `=========` / `---------` | Common GameFAQs |
| Numbered section | `1. Getting Started`, `IV. Endgame` | Walkthrough numbering |
| ALL CAPS short line | `BOTTLE GROTTO` (< ~72 chars, not a sentence) | Weak alone; stronger with neighbours |
| Bracket label | `[Walkthrough]` | Some FAQs / fan guides |

Each candidate returns:

```js
{ title: string, level: number, confidence: number, lineIndex: number }
```

**Breadcrumb:** maintain a stack by `level` → `section_path: string[]` (raw author
text, no normalization to a game taxonomy).

**Confidence:** sum weighted signals; below threshold → treat line as body text, not
heading. No heading parser is 100% accurate; low-confidence guides still work via
Phase 2 fallbacks.

### 1.2 Extend `chunkGuide()` → `chunkGuideWithMeta(text)`

Return:

```js
{
  text: string,
  section_path: string[],      // e.g. ["Walkthrough", "Bottle Grotto"]
  section_confidence: number,    // 0..1 from outline at chunk start
  chunk_index: number,           // 0-based order in guide (already implied today)
}
```

Implementation sketch:

1. Run outline pass → map each character offset / line to `section_path`.
2. Reuse existing `splitIntoUnits` / pack logic from `lib/chunk-guide.js`.
3. When flushing a chunk, attach the `section_path` active at chunk start.
4. Keep `chunkGuide(text)` as a thin wrapper returning `string[]` for callers that
   only need text (tests, legacy).

### 1.3 Database migration: `db/guide-chunk-outline.sql`

Add nullable columns to `public.guide_chunks`:

```sql
alter table public.guide_chunks
  add column if not exists section_path text[] default '{}',
  add column if not exists section_confidence real;
```

Optional later: GIN index on `section_path` if we filter in SQL; **not required for
v1** (rescoring happens in Node on top-K only).

Update `match_guide_chunks` RPC to return the new fields (or add
`match_guide_chunks_v2` if we want zero-downtime; prefer extending the existing RPC
since the table is small per guide).

### 1.4 Ingest wiring (`lib/guide-ingest.ts`)

- Persist `section_path`, `section_confidence` on insert.
- **Embed input:** prefix only when confidence ≥ cutoff (e.g. 0.5):

  ```
  [Section: Walkthrough > Bottle Grotto]
  {chunk_text}
  ```

  Prefix affects embedding and retrieval; store **unprefixed** `chunk_text` in DB for
  display and rescoring. Re-ingest required after deploy.

### 1.5 Re-ingest strategy

- New ingests get metadata automatically.
- Existing rows: lazy re-ingest on next `ensureGuideIngested` miss is **not** enough
  (chunks already exist). Options:
  - **A (recommended):** one-time admin script `scripts/reingest-guide-outlines.mjs`
    that deletes + re-ingests by `guide_url` list or all rows.
  - **B:** version column `outline_version`; retrieval ignores rows with old version
    and triggers background re-ingest (more moving parts).

Document in [preferred-guide.md](../preferred-guide.md) after ship.

### 1.6 Acceptance criteria

- [ ] GameFAQs `?print=1` sample (Links Awakening FAQ) — Bottle Grotto section path
  appears on chunks containing Power Bracelet acquisition.
- [ ] Uploaded `.md` with `#` headings — paths match markdown hierarchy.
- [ ] Plain paragraph-only text — `section_path = []`, ingest still succeeds.
- [ ] `npm run check` covers outline detector + `chunkGuideWithMeta` self-check.

---

## Phase 2 — Rules-based rescoring (no Cohere)

### 2.1 New module: `lib/guide-rescore.js`

Pure function:

```js
rescoreGuideChunks({ query, searchTopic, game, chunks }) → chunks[]
```

Input `chunks`: rows from `match_guide_chunks` (+ metadata from Phase 1), **before**
optional Cohere. Output: same rows, reordered, with debug `rescore_reasons[]` for
trace (optional metadata on trace event).

**Run after:** cosine fetch + `dedupeByChunkText` + slice to `RETRIEVE_K` is wrong —
rescore should operate on the **over-fetched** set (`RETRIEVE_FETCH`), then take top
`RETRIEVE_K`. Today `RETRIEVE_FETCH = 20`; keep that.

Wire in `lib/guide-rag.ts` **after** DB match, **before** Cohere (Cohere becomes
second opinion when key is set, not the only ranker).

### 2.2 Scoring signals (game-agnostic)

Each signal adds a weighted delta to cosine `similarity`. Weights tuned on eval set,
not hardcoded per game.

#### S1 — Section / query overlap

- Tokenize `searchTopic` + raw `query` (lowercase, strip stopwords).
- Boost if tokens appear in `section_path.join(" ")` or chunk opening (~200 chars).
- Player-mentioned proper nouns ("bottle grotto", "chapter 3") are high-value tokens;
  no built-in list — whatever appears in the question counts.

#### S2 — Progress continuity (temporal)

**Query hints** (multilingual-friendly keyword lists, not ML):

- Early / just happened: `just`, `baru`, `currently`, `inside`, `acquired`, `got`,
  `picked up`, `opened the chest`

**Chunk forward-jump hints** (penalize):

- `after you leave`, `outside`, `return to`, `brought back`, `completed`,
  `defeated the final`, `once it's over`

If query has early hint and chunk has forward-jump hint → penalty. Symmetric rule if
query asks about endgame ("after beating the boss") → penalize early-section chunks.

#### S3 — Acquisition anchor

If query references obtaining something (item, key, ability — detected by patterns
like `get the`, `receive`, `open the chest`, or noun after "got"/"dapetin"):

- Boost chunk where that phrase **co-occurs with an acquire verb** in the same chunk.
- Extra boost for `chunk_index` and `chunk_index + 1` (next steps often in adjacent
  chunk due to ~500-token splits).

No item name allowlist — match uses tokens from the rewrite/searchTopic.

#### S4 — Tier / variant disambiguation (generic)

Detect **upgraded labels** in chunk vs query:

- Regex family: `level\s*\d`, `lv\.?\s*\d`, `\+(\d+)`, `\bmk\.?\s*ii\b`,
  `\b(advanced|improved|upgraded|enhanced|super)\b` (case-insensitive)

If chunk has tier marker and query/base phrase does not → penalty. If query includes
tier → boost matching tier in chunk.

Covers Power Bracelet vs Level 2 Power Bracelet, Sword vs Master Sword, etc., without
per-game tables.

#### S5 — Lexical overlap (light BM25-ish)

Cheap token overlap score between `searchTopic` and `chunk_text` (already in top-20).
Small weight — embeddings already do most of this; helps exact names embeddings blur.

### 2.3 Trace / debug

Extend `rag_similarity_score` metadata:

```json
{
  "reranked": "rules",
  "chunks": [
    {
      "similarity": 0.716,
      "rescore_delta": 0.12,
      "rescore_reasons": ["section_overlap", "acquisition_anchor"],
      "section_path": ["Walkthrough", "Bottle Grotto"]
    }
  ]
}
```

Set `RAG_DEBUG=1` to log before/after order.

### 2.4 Acceptance criteria

- [ ] Replay traces `765789c7` query against ingested LA FAQ — correct chunk (pots
  after PB) ranks **#1 or #2** without Cohere.
- [ ] `npm run eval:rag` — rank-1 improves vs cosine-only baseline on eval set;
  record numbers in this doc when run.
- [ ] No game name branches in `lib/guide-rescore.js` (grep check in review).

---

## Phase 3 — Summarize guardrails

### 3.1 `lib/prompt.js` — extend `preferredDirective`

Add **game-agnostic** rules when `hasPreferred`:

1. Multiple `PREFERRED GUIDE` excerpts may describe **different points** in the
   walkthrough. Use only excerpts **consistent with the player's stated location and
   progress** (what they say they already did or where they are).
2. If excerpts conflict, prefer the one whose steps **immediately follow** the event
   the player described (e.g. right after obtaining something), not a later upgrade
   or after leaving the area.
3. Do **not** combine steps from excerpts that are not sequential in the same arc.
4. When two excerpts name similar rewards with different steps, prefer the excerpt
   **without** upgraded/tiered labeling unless the player asked for the upgrade.

Keep wording short; avoid game examples in the prompt (reduces overfitting).

### 3.2 Acceptance criteria

- [ ] Same LA query with **intentionally bad** rank order (cosine-only fixture in
  test) — summarize still picks correct steps more often than today (manual or
  scripted check).
- [ ] No regression on non-guide turns (no preferred URLs).

---

## Evaluation plan

### Regression cases (minimum)

Add rows to `docs/plan/rag-eval-set.jsonl` (gitignored) or a committed fixture file:

| id | game | query gist | must_rank_top2_chunk_contains |
|----|------|------------|------------------------------|
| `la-pb-after` | Link's Awakening | after Power Bracelet in Bottle Grotto | `lift up the pots behind the chest` |
| `la-pb-wrong` | Link's Awakening | same | must NOT rank `Level 2 Power Bracelet` + `large statues` above correct |

### Metrics

| Metric | Baseline (cosine) | Target after Phase 2 |
|--------|-------------------|----------------------|
| rank-1 accuracy (in-guide procedural) | 3/6 (calibration) | ≥ 5/6 without Cohere |
| rank-1 on LA PB case | #5 | #1 or #2 |
| Cohere optional uplift | 6/6 | still ≥ 6/6 when key set |

Run: `npm run eval:rag` with `COHERE_API_KEY` unset vs set.

---

## Implementation order & PR slicing

| PR | Scope | Risk |
|----|-------|------|
| **PR1** | `lib/guide-outline.js` + `chunkGuideWithMeta` + unit self-check | Low — no runtime change until ingest |
| **PR2** | SQL migration + ingest persist + re-ingest script | Medium — requires re-ingest |
| **PR3** | `lib/guide-rescore.js` + `guide-rag.ts` wire-up + trace | Medium — behaviour change |
| **PR4** | `prompt.js` guardrails | Low |
| **PR5** | Eval fixtures + doc update + `CLAUDE.md` | Low |

Ship PR1+2 together or back-to-back so we do not embed without metadata paths.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Wrong heading detection pollutes `section_path` | Confidence threshold; empty path fallback |
| Over-aggressive forward-jump penalty | Tune weights on eval set; cap max penalty |
| Re-ingest cost / downtime | Script per guide URL; dev first |
| Rules rescoring hurts another game | Eval set spans ≥ 2 guides; no game-specific branches |
| Cohere + rules fight | Apply rules first, Cohere second; log both |

---

## Relationship to [rag-tuning-roadmap.md](./rag-tuning-roadmap.md)

| Roadmap phase | This plan |
|---------------|-----------|
| Phase C (Cohere rerank) | **Optional overlay** — keep, do not depend on |
| Phase D (BM25 hybrid) | **Partially addressed** by S5 lexical overlap on top-20; full Postgres `tsvector` deferred unless eval shows recall misses |
| Phase E (parent–child) | **Not in scope** — outline metadata is lighter; revisit if "right section, wrong half-step" persists |

---

## Decision log

| Date | Decision |
|------|----------|
| 2026-07-26 | Prioritize outline + rules rescoring + prompt over Cohere retry |
| 2026-07-26 | No game ontology; structural metadata + generic text signals only |
| 2026-07-26 | Implementation order: Phase 1 → 2 → 3 |
| 2026-07-26 | Motivated by traces `765789c7` (cosine fail) and `86e594bb` (Cohere ok) |
| 2026-07-26 | **Rules-after-Cohere** (shipped): Cohere supplies `relevant`; rules own final order. Revert: `GUIDE_RULES_AFTER_COHERE=0` or revert `lib/guide-rag.ts` rules-after-cohere block |

---

## Rules-after-Cohere (revertable)

**Pipeline:** `cosine fetch → rules rescore → top-K → Cohere reorder → rules rescore again → summarize`

Cohere can promote semantically similar but progress-wrong chunks (trace `50222ad8`: forward-jump at rank 1). A second rules pass restores progress-aware order without dropping Cohere’s routing verdict.

**Trace:** `rag_similarity_score.metadata.rules_after_cohere: true` when the second pass ran.

**Revert without code change:**

```bash
# .env.local — Cohere keeps routing + final order (old behaviour)
GUIDE_RULES_AFTER_COHERE=0
```

**Revert with git:** single block in `lib/guide-rag.ts` after `cohereRerankChunks` (search `rulesRescoreAfterCohereEnabled`).
