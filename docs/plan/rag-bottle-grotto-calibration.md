# Bottle Grotto multi-turn RAG calibration (July 2026)

**Status:** Recorded (2026-07-26)  
**Game / guide:** The Legend of Zelda: Link's Awakening (Game Boy) — [GameFAQs FAQ 18445](https://gamefaqs.gamespot.com/gameboy/563277-the-legend-of-zelda-links-awakening/faqs/18445)  
**Related:** [rag-outline-rescore.md](./rag-outline-rescore.md), `lib/guide-progress.js`, `lib/guide-rescore.js`, `lib/guide-rag.ts`, `scripts/test-la-turns-1-4.mjs`

## Purpose

Live multi-turn follow-up session exposed ranking and summarize drift inside a **single
preferred guide**. This doc records the test scenario, traces, fixes shipped, automated
regression runs, and conclusions so future tuning does not re-discover the same failures.

**Non-goal:** Zelda-specific rules in code. All signals are game-agnostic; LA is the
calibration fixture only.

---

## Test scenario (4 turns)

Multi-turn chat in Bottle Grotto after attaching the GameFAQs walkthrough:

| Turn | Player question (ID) | Expected guide arc |
|------|----------------------|-------------------|
| **T1** | `di bottle grotto, aku baru aja buka peti untuk dapetin power bracelet, setelah itu kemana ya?` | Leave room → lift pots → crystal switch → Key |
| **T2** | `setelah dapet kunci kemana lagi?` | Toward **Nightmare's Key** puzzle |
| **T3** | `trus setelah itu kemana?` | After Nightmare's Key → north → east → Gel/Pols → basement → elevators → pot → west stairs |
| **T4** | `udah turun elevator dan ke barat naik tangga, setelah itu?` | **Genie** boss → Heart Container → **Conch Horn** |

**T4 ground truth (guide text):** chunk after west stairs opens with *"In this room,
follow the path to the southern end… meet the Genie… take the Conch Horn!"* — neighbor
of the tail-endpoint chunk that ends at *"go west and up the stairs to reach the next room."*

---

## Failure pattern (before fixes)

### Retrieval: `acquisition_anchor` beat neighbor by ~0.009

On T4, rewrite mentions *"already obtained the Nightmare's Key"* → early dungeon chunks
(Stalfos / Key / Compass) got `acquisition_anchor` (+0.12) and outranked the Genie neighbor
(`neighbor_continuation_boost` +0.16) on raw rescore score.

Example trace **`3fe93542`** (no Cohere):

| Rank | Score | Reasons | Chunk |
|------|-------|---------|-------|
| #1 | 0.880 | `acquisition_anchor`, `lexical_overlap` | Early BG — Stalfos / Mask-Mimic |
| #2 | 0.871 | `neighbor_continuation_boost` | Genie (almost correct) |

### Summarize: correct rank-1 ignored when K=5 excerpts

Trace **`7ededf09`** (after neighbor pin, before rank-1 trim):

- Retrieval rank-1: **Genie** (`neighbor_rank_pin`) ✅
- Summarize received **5** preferred excerpts; model followed excerpt #2 (Hinox dark room) ❌
- `PROGRESS FOLLOW-UP (strict)` in prompt was not enough alone

### Cohere made summarize drift worse, not better

Trace **`b9cfacdc`**: Cohere + rules-after-Cohere → Genie rank-1 ✅, answer Hinox ❌
(history + extra excerpts).

---

## Fixes shipped (2026-07-26)

| # | Change | Module |
|---|--------|--------|
| 1 | Disable `acquisition_anchor` when `isPositionProgressFollowUp` | `lib/guide-rescore.js` |
| 2 | Post-sort `neighbor_rank_pin` — force `neighbor_of_tail` to rank-1 on position follow-up | `lib/guide-rescore.js` |
| 3 | `limitSourcesForPositionFollowUp` — send **only rank-1** preferred excerpt to summarize | `lib/guide-progress.js`, `app/api/solve/route.ts` |
| 4 | `extractQueryFocalItem` — parse *"already obtained X and navigated"* rewrites → `queryPostAcquisition` suppresses `acquisition_anchor` | `lib/guide-rescore.js` |

Supporting signals (already shipped): `lib/guide-progress.js` (landmarks, tail endpoint,
continuation opening), neighbor fetch in `lib/guide-rag.ts`, `PROGRESS FOLLOW-UP (strict)`
in `lib/prompt.js`.

**Env:** `GUIDE_RULES_AFTER_COHERE=1` (default on) re-applies rules after Cohere reorder.
Set `GUIDE_RULES_AFTER_COHERE=0` only to let Cohere own final order (revert path).

---

## Key traces (chronological)

| Trace | Cohere | Turn | Retrieval | Answer | Notes |
|-------|--------|------|-----------|--------|-------|
| `3fe93542` | off | T4 | ❌ Stalfos rank-1 (`acquisition_anchor`) | ❌ Hinox | Root cause: anchor beat neighbor 0.009 |
| `7ededf09` | off | T4 | ✅ Genie rank-1 | ❌ Hinox | Summarize drift with 5 excerpts |
| `26953256` | off | T4 | ✅ Genie | ✅ Genie → Conch | UI confirm after rank-1 trim |
| `a8340c9d` | off | T4 | ✅ Genie | ✅ Genie → Conch | Script E2E after trim |
| `3d855f3c` | on | T4 | ✅ Genie | ✅ Genie (no Hinox) | Cohere + rules-after + trim |
| `b9cfacdc` | on | T4 | ✅ Genie | ❌ Hinox | Pre-trim baseline |

---

## Automated regression: turns 1–4

**Script:** `node scripts/test-la-turns-1-4.mjs` (hits `POST /api/solve`, builds history per turn).

**No Cohere:** start dev with `COHERE_API_KEY= npm run dev` (empty string overrides
`.env.local`). Verify traces show `reranked: false`.

**With Cohere:** normal `npm run dev` with `COHERE_API_KEY` set. Verify `reranked: true`,
`rules_after_cohere: true`.

### Suite `3019f2dd` — without Cohere (~53s total)

| Turn | Latency | Verdict | Notes |
|------|---------|---------|-------|
| T1 | ~7.3s | ✅ | Lift pots, crystal switch |
| T2 | ~17.4s | ✅ | Nightmare's Key path |
| T3 | ~7.3s | ⚠️ | Drift to Compass / Water Tektites (bad T1–T2 chain in that run) |
| T4 | ~20.7s | ✅ | Genie + Conch Horn; `positionFollowUpRankOne: true` |

### Suite `e9f73d9b` — with Cohere (~36s total)

| Turn | Latency | Verdict | Notes |
|------|---------|---------|-------|
| T1 | ~8.3s | ✅ | Lift pots, crystal |
| T2 | ~12.1s | ✅ | Nightmare's Key |
| T3 | ~7.7s | ✅ | Basement, elevators, west stairs |
| T4 | ~8.3s | ✅ | Genie; no Hinox; Conch optional in prose |

### T3 rerun without Cohere — suite `f5bfb94e`

Single confirm run after T1–T2 fresh:

- **Trace:** `f5bfb94e-t3-37dfff6e-4f8a-48ee-bfe6-9c0ffa8f73bf`
- `reranked: false`
- ✅ Post–Nightmare's Key through basement → elevators → west → stairs
- Shows T3 without Cohere is **history-sensitive** but can pass with a clean chain

### Post-focal-fix regression (all fixes shipped) — July 2026

After `extractQueryFocalItem` *"already obtained X and navigated"* fix:

| Suite | Cohere | Total | T1 | T2 | T3 | T4 |
|-------|--------|-------|----|----|----|----|
| `42b987cd` | off | ~34s | ✅ | ✅ | ✅ | ✅ Genie + Conch |
| `5b12f5dc` | on | ~83s | ✅ | ✅ | ✅ | ✅ Genie + Conch |

T4 traces: no `acquisition_anchor`; rank-1 `neighbor_continuation_boost`; `positionFollowUpRankOne: true`.

**Verdict:** Both modes pass full T1–T4 after the fix stack. Cohere is **optional** (cost/latency
tradeoff); keep `GUIDE_RULES_AFTER_COHERE=1` when Cohere is on.

---

## T4 detail (target turn)

Both modes after all fixes:

| | No Cohere (`3019f2dd-t4`) | With Cohere (`e9f73d9b-t4`) |
|---|---------------------------|------------------------------|
| `neighbor_rank_pin` | yes | yes |
| `positionFollowUpRankOne` | 5 → 1 excerpt | 5 → 1 excerpt |
| `acquisition_anchor` | none | none |
| Hinox in answer | no | no |
| Genie in answer | yes | yes |
| Conch Horn | yes | sometimes omitted (direction still correct) |

---

## Findings

### 1. Root cause was ranking + excerpt count, not Cohere

Cohere can help vague follow-ups (T3) or hurt if rules-after-Cohere is off. Turn 4
stability comes from **rules rescoring** + **rank-1 summarize trim**, not from enabling
the reranker.

### 2. Two follow-up types need different strategies

| Type | Example | Strategy |
|------|---------|----------|
| **Vague progress** | `trus setelah itu kemana?` | `continuation_boost`, chat history; Cohere helps consistency |
| **Position progress** | elevator + west + stairs | Tail/neighbor fetch, suppress `acquisition_anchor`, `neighbor_rank_pin`, **rank-1 only** to summarize |

### 3. GameFAQs `?print=1` chunks are huge

One chunk can span PB → basement → Hinox → Genie. High recall, noisy rank-1 **preview**
in admin traces even when the answer is correct. Genie excerpt still includes overworld
tail after `=========` (not trimmed yet).

### 4. Summarize guardrails alone are insufficient

`PROGRESS FOLLOW-UP (strict)` did not stop Hinox when five conflicting excerpts were
present. Trimming to rank-1 on position follow-up was the decisive summarize fix.

### 5. `sourcesForSolveLog` now aligns with summarize input

After rank-1 trim, admin citation preview matches the excerpt that drove the answer
(see `26953256` vs pre-fix `7ededf09`).

---

## Conclusions

1. **Shipped stack is production-ready for T4 position follow-ups** with or without
   Cohere, given `GUIDE_RULES_AFTER_COHERE=1` when Cohere is on.
2. **Cohere is optional acceleration** — faster on full 4-turn runs in one session;
   slightly more stable on vague T3; not required for correct T4.
3. **Remaining variance:** T3 without Cohere depends on prior-turn answer quality in
   history; T4 answer completeness (Conch Horn mention) varies; rank-1 log preview can
   mislead on mega-chunks.
4. **Recommended next steps (backlog):**
   - Trim preferred chunks at `=========` section breaks before summarize
   - Consider rank-1 trim for **vague** `isProgressFollowUp` (not only position) if T3
     no-Cohere drift recurs in production
   - ~~Fix `extractQueryFocalItem` for *"already obtained X and navigated"*~~ **Shipped**
     2026-07-26 — `already obtained` pattern + `\s+and` terminator; gates
     `queryPostAcquisition` → suppresses `acquisition_anchor` on non-position rewrites

---

## How to reproduce

```bash
# Terminal 1 — without Cohere
COHERE_API_KEY= GUIDE_RULES_AFTER_COHERE=1 npm run dev

# Terminal 2
node scripts/test-la-turns-1-4.mjs

# With Cohere: normal npm run dev, then same script
```

Single-turn T4 only (minimal history): see inline script in agent session or POST
`/api/solve` with four prior history turns and `preferredUrls` set to the FAQ URL.

**Trace lookup:** `/admin/traces` or `trace_events` / `solve_logs` filtered by
`trace_id`.

---

## Files touched in this calibration

| File | Role |
|------|------|
| `lib/guide-progress.js` | Position/vague follow-up detection, `limitSourcesForPositionFollowUp` |
| `lib/guide-rescore.js` | Rules signals, `neighbor_rank_pin`, anchor suppression |
| `lib/guide-rag.ts` | Tail neighbor fetch, rules-after-Cohere pass |
| `lib/prompt.js` | `PROGRESS FOLLOW-UP (strict)` |
| `app/api/solve/route.ts` | Rank-1 trim + `positionFollowUpRankOne` trace field |
| `scripts/check.mjs` | Unit fixtures for T4 trace `3fe93542`, trim helper |
| `scripts/test-la-turns-1-4.mjs` | 4-turn regression script |
