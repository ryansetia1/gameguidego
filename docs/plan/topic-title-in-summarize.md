# Topic title: fold into summarize (kill the third LLM call)

**Status:** Shipped (July 2026)  
**Goal:** On the first turn of a new topic, emit `topicTitle` from the existing
`summarize` JSON instead of a separate `generateTopicTitle` Gemini call.  
**Saves:** 1 Replicate call + sequential latency per new topic (3 → 2 LLM calls on turn 1).

## Problem

Today a new topic pays **three** sequential Gemini calls on turn 1:

1. `resolveQuestion` — rewrite for search/RAG  
2. `summarize` — answer + highlights + spoilers  
3. `generateTopicTitle` — short thread label (`topic_title` kind)

Calls 2 and 3 overlap in context (both see the question; call 3 also sees the
answer). Call 3 only runs when `history.length === 0` and the stored title is still
auto-derived (`isAutoDerivedTopicTitle`). Follow-ups already skip title generation.

The extra call adds wall-clock time **after** the answer is ready, so the UI keeps
the topic-title skeleton visible until call 3 finishes.

## Current flow (reference)

```
persistChat (turn 1, user message)
  → title = truncateTitle(first question)     # lib/topic-title.js

POST /api/solve (history = [])
  → resolveQuestion
  → summarize → answer
  → [optional] censorSpoilers
  → generateTopicTitle(question, finalAnswer)   # lib/replicate.ts
  → SSE result { topicTitle }
  → client persist + saveTopicTitleById
```

**Touchpoints today**

| Area | File |
|------|------|
| Title LLM + parse | `lib/replicate.ts` (`generateTopicTitle`), `lib/prompt.js` (`TOPIC_TITLE_*`) |
| Parse helper | `lib/topic-title.js` (`parseGeneratedTopicTitle`) |
| Orchestration | `app/api/solve/route.ts` (~L506–612) |
| Client apply | `app/chat/execute-chat-turn.ts`, `app/chat/turn-persist.ts` |
| UI skeleton | `lib/topic-title.js` (`shouldShowTopicTitleSkeleton`), `app/page.tsx` |
| Tests | `scripts/check.mjs` (parseSummary + topicTitleForPersist asserts) |

## Chosen design

Extend the **summarize** JSON schema on **first turn only**:

```json
{
  "answer": "...",
  "highlights": [],
  "spoilers": [],
  "topicTitle": "Malenia phase 2"
}
```

Rules (reuse existing `TOPIC_TITLE_INSTRUCTION` copy, inlined into summarize prompt):

- Only requested when `isFirstTurn === true` (`history.length === 0` at `/api/solve`).
- Max 8 words, &lt; 60 chars, same language as the player's question.
- Name the subject (boss, quest, item, build, mechanic), not the full question.
- No game name or platform in the title.
- Omit spoiler reveals in the title (same as today).

**Follow-ups:** `buildPrompt` does **not** mention `topicTitle`; model should not emit
the field. `parseSummary` treats a missing/empty `topicTitle` as `""`.

**Persistence / rename rules:** unchanged. `topicTitleForPersist` still wins for manual
renames; client + server apply paths stay the same.

### Why summarize (not censor)

`generateTopicTitle` today runs on `finalAnswer` **after** `censorSpoilers`. Folding
into summarize means the title is derived from the **pre-censor** draft.

| Approach | Calls saved | Title context |
|----------|-------------|---------------|
| Fold into summarize (chosen) | 1 | Pre-censor answer (in same generation) |
| Fold into censor output | 0 on spoiler-OFF turns; messy | Post-censor |
| Keep separate call | 0 | Post-censor |

**Acceptable risk:** title prompt already forbids spoilers; censor path is rare
(spoilers OFF + `spoilerRisk`). Monitor admin traces on censored turns; if titles
leak, add a one-line strip in `topicTitleForPersist` or revert.

### What we delete after ship

- `generateTopicTitle` in `lib/replicate.ts`
- `TOPIC_TITLE_INSTRUCTION`, `buildTopicTitlePrompt` in `lib/prompt.js` (text moves into summarize block)
- `topic_title` branch in `/api/solve` (keep `topicTitleForPersist` + DB write)
- `topic_title_complete` trace can become `topic_title_from_summarize` or reuse with `source: "summarize"`

**Keep** `parseGeneratedTopicTitle` in `lib/topic-title.js` (or rename to
`coerceTopicTitle`) for shared truncation/validation — used by `parseSummary`.

## Implementation plan

### Phase 1 — Prompt + parse (no route change yet)

1. **`lib/prompt.js`**
   - Add `buildTopicTitleSummarizeRules()` (or inline block) with the existing
     `TOPIC_TITLE_INSTRUCTION` bullets.
   - `buildPrompt({ ..., isFirstTurn })`: when `isFirstTurn`, append to the JSON
     schema section:
     - `"topicTitle": "very short thread label (first turn only)"`
     - Include the title rules block once (do not duplicate on follow-ups).

2. **`lib/highlights.js` — `parseSummary`**
   - Import `parseGeneratedTopicTitle` (or move coercion next to parse).
   - Return `topicTitle: string` (default `""`).
   - Extend return type; empty string when field missing or invalid.

3. **`lib/replicate.ts`**
   - `SummarizeInput`: add `isFirstTurn?: boolean`.
   - `SummaryResult`: add `topicTitle?: string`.
   - Pass `isFirstTurn` into `buildPrompt`.
   - Map `parseSummary(...).topicTitle` into result.
   - **Do not remove** `generateTopicTitle` yet (Phase 2 uses flag).

4. **`scripts/check.mjs`**
   - Assert `parseSummary` extracts `topicTitle` from valid JSON.
   - Assert missing `topicTitle` on follow-up-shaped fixtures → `""`.
   - Assert truncation still applies (&gt; 60 chars).

Run `npm run check`.

### Phase 2 — Wire `/api/solve` + remove third call

1. **`app/api/solve/route.ts`**
   - `const isFirstTurn = history.length === 0` (already exists).
   - Pass `isFirstTurn` into `summarize({ ... })`.
   - After summarize (+ censor), set:
     ```ts
     let topicTitle: string | undefined;
     if (isFirstTurn && shouldGenerate) {
       const fromSummary = summarizeResult.topicTitle?.trim();
       if (fromSummary) { /* same topicTitleForPersist + DB path as today */ }
     }
     ```
   - Delete `generateTopicTitle` import and call block.
   - Trace: log when title came from summarize vs fallback.

2. **Delete dead code**
   - `generateTopicTitle` function in `lib/replicate.ts`
   - `TOPIC_TITLE_INSTRUCTION`, `buildTopicTitlePrompt` from `lib/prompt.js`
   - Unused imports (`parseGeneratedTopicTitle` from replicate if only used there)

3. **`lib/llm-log.ts`**
   - Leave `topic_title` in the union for historical rows; add comment "legacy — merged into summarize".

Run `npm run check`, `npm run build`.

### Phase 3 — UI / skeleton (optional polish)

`shouldShowTopicTitleSkeleton` today waits until the **assistant answer** lands.
After merge, title arrives in the **same** SSE `result` as the answer, so skeleton
duration should shrink automatically.

Verify manually:

- First turn: skeleton → typewriter title in one `result` event (no second wait).
- Follow-up: title unchanged.
- User rename: still sticky.

No code change required unless QA shows skeleton flashing too long; then tighten
`skeleton` to key off `loading` only until `result` (not a third network wait).

### Phase 4 — Docs

- Update `CLAUDE.md` (turn-1 call count 3 → 2; topic title source).
- Set this plan **Shipped** in `docs/plan/README.md`.

## Out of scope

- Changing `topicTitleForPersist`, rename UX, or topic list UI.
- Generating titles on follow-ups.
- New env flag (revert is a git revert; see below). Add a flag only if prod needs
  hot-toggle without deploy.

## Validation

### Automated

```bash
npm run check
npm run build
```

### Manual (before merge)

| Case | Expected |
|------|----------|
| New topic, EN question | Short EN title, not full question |
| New topic, ID question | Short ID title |
| Follow-up turn | Title unchanged; no `topicTitle` in summarize prompt |
| User renamed title | LLM title ignored on persist |
| Spoilers OFF + `spoilerRisk` → censor | Answer censored; title has no major reveal |
| `generateTopicTitle` removed | No `topic_title` rows in new `llm_calls` / `llm-log.json` |

### What to watch after deploy

1. **Empty titles:** % of first turns where `topicTitle` is empty → falls back to
   truncated question (same as today on LLM failure).
2. **Title quality:** sidebar/topic list — too long, includes game name, or copies
   full question.
3. **Answer regression:** compare summarize quality (highlights/spoilerRisk) on a
   fixed set of 5–10 real traces before/after.
4. **Latency:** turn-1 `generation_complete` → `result` gap should shrink (~one
   Replicate round-trip).
5. **Admin traces:** `/admin` — no post-answer `topic_title` call; `topicTitle` on
   `result` payload.

## Revert

No feature flag in v1 — revert is a **code change** (or git revert).

### Option A — Git (preferred)

Ship Phases 1–2 as one commit when possible:

```bash
git log --oneline -- lib/prompt.js lib/highlights.js lib/replicate.ts app/api/solve/route.ts scripts/check.mjs

git revert <commit-sha>

npm run check
npm run build
```

### Option B — Manual restore separate call

1. **`lib/prompt.js`:** restore `TOPIC_TITLE_INSTRUCTION` + `buildTopicTitlePrompt`;
   remove `topicTitle` from summarize JSON schema / `isFirstTurn` block in `buildPrompt`.
2. **`lib/highlights.js`:** remove `topicTitle` from `parseSummary` return.
3. **`lib/replicate.ts`:** restore `generateTopicTitle`; remove `isFirstTurn` /
   `topicTitle` from `summarize` input/output.
4. **`app/api/solve/route.ts`:** restore post-censor `generateTopicTitle` block;
   stop reading `topicTitle` from summarize result.
5. **`scripts/check.mjs`:** drop merged-title asserts; keep `topicTitleForPersist` tests.
6. `npm run check` && `npm run build`.

### Option C — Partial rollback (keep merge, soften prompt)

If answers are fine but titles are bad:

- Move title rules to a **shorter** bullet list (less prompt noise).
- Add: "If unsure, set `topicTitle` to the main noun phrase from the question."
- Do **not** reintroduce the third call unless empty-title rate is high.

### Data / DB

No migration. Existing `chats.title` values are unchanged. Revert only affects
**new** first turns after deploy.

## Related code

- Title persistence: `lib/topic-title.js`, `app/chat/turn-persist.ts`
- SSE client: `app/chat/execute-chat-turn.ts`, `app/chat/solve-stream.ts`
- Typewriter UI: `app/chat/topic-title-typewriter.tsx`
