# Guide source selector (per-turn RAG targeting)

**Status:** Planned (July 2026)  
**Audience:** Future agents implementing or maintaining this feature  
**Last updated:** 2026-07-27  
**Related:** `lib/guide-rag.ts`, `lib/guide-retrieval-mode.js`, `app/chat/composer-shell.tsx`, `app/api/solve/route.ts`

## Purpose

When a game room has **more than one** preferred guide (e.g. full walkthrough + character-build FAQ + uploaded PDF), RAG today searches **all** indexed guides and returns the top chunks by similarity. That is correct for general questions but wrong when the player wants a **dedicated** source for this turn (build guide, character sheet, boss-only FAQ).

This feature adds a **per-message** multi-select in the composer so the player can:

1. **Auto** (default) — same as today: pool all attached guides, let similarity/rerank pick.
2. **Subset** — check one or more specific guides; RAG only retrieves from those URLs this turn.

Example: three guides attached; user asks about a Nightreign build → selects only the build FAQ before Send.

## Product decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Multi-select** — any non-empty subset of attached guides (not radio-only). |
| 2 | **Per message** — selection applies to the turn being sent, not a sticky session pref. Composer resets to **Auto** after a successful send. Retry/regenerate/edit restore the selection stored on that user message. |
| 3 | **Unindexed guides** — shown in the picker but **disabled** with status hint (Indexing… / Failed / Retry from game card). Cannot be selected until `indexed`. |
| 4 | **Auto dominance** — acknowledged: Auto can let one guide win all five chunk slots; subset mode is the fix. No server-side “fair share across guides” in v1. |

**Visibility:** strip only when `preferredUrls.length > 1`. One guide = no selector (nothing to choose).

**Orthogonal to web toggles:** `Search web instead` / `Also search web` (`lib/guide-retrieval-mode.js`) stay in the `+` menu. Subset selection is hidden/disabled when `skipPreferredGuide` is on (no RAG this turn).

## UX

### Composer strip (collapsed)

Thin row **above** `.composer-inner`, inside `.composer` form — matches the annotated mock (red line at top of docked composer).

```
┌──────────────────────────────────────────┐
│ Guides · Auto                        ▴  │  ← tap expands upward
├──────────────────────────────────────────┤
│ Ask a follow-up...                   + ➤│
└──────────────────────────────────────────┘
```

Collapsed label rules:

| Selection | Label |
|-----------|--------|
| Auto (`null`) | `Guides · Auto` |
| 1 guide | `Guides · {short title}` |
| 2+ guides | `Guides · {n} selected` |

Use `guideMeta[url].title` when available; fallback `gameCardGuideRow` label.

### Expanded panel (opens upward)

Popover anchored to the strip, `position: absolute; bottom: 100%` so it grows **up** over the message list (not into the `+` menu).

```
┌──────────────────────────────────────────┐
│ ☑ Auto (all guides)                      │
│ ─────────────────────────────────────    │
│ ☐ GameFAQs full walkthrough              │
│ ☑ Character build FAQ                    │
│ ☐ Your PDF guide          (Indexing…)    │
└──────────────────────────────────────────┘
│ Guides · 1 selected                  ▾  │
├──────────────────────────────────────────┤
```

Interaction:

- **Auto** checked → clear manual subset; disable individual rows until Auto unchecked (or: checking Auto unchecks all others — pick one pattern in impl, document in code).
- Manual subset → Auto off. Checking every indexed guide normalizes to Auto on send (optional UX sugar).
- Tap outside / Escape closes panel.
- Strip disabled while `loading`, `guideIndexing` blocking send, or `composerLocked`.

### Copy (brand voice)

| Element | Copy |
|---------|------|
| Strip aria | `Guide sources for this question` |
| Auto row | `Auto (all guides)` |
| Disabled row | append status from `GuideStatusChip` / `resolveGuideDisplayState` — e.g. `Indexing…`, `Not indexed` |
| Send blocked (only unindexed selected) | `Wait for your guide to finish indexing, or choose Auto.` |

## API (`POST /api/solve`)

New optional field:

| Field | Type | Effect |
|-------|------|--------|
| `ragGuideUrls` | `string[]` | RAG retrieval subset. Omitted, empty, or equals full `preferredUrls` set → **Auto** (all attached). Otherwise retrieve only from this list. |

Trust boundary — new `coerceRagGuideUrls(record, preferredUrls)` in `lib/guide-urls.js` (or `lib/guide-source-selection.js` if we want isolation):

1. Normalize each URL (`normalizePreferredGuideUrl`).
2. Drop any URL not in `preferredUrls` (silent strip, not 400).
3. Dedupe preserving order.
4. If result is empty **or** same set as all `preferredUrls` → treat as Auto (`undefined` internally).

Pass coerced list into `retrieveFromPreferredGuides({ guideUrls: effectiveRagUrls })` instead of always `preferredUrls`.

Include in rewrite cache key (`rewrite::…` hash in `solve/route.ts`) alongside `skipPreferredGuide`, `alsoSearchWeb`, `forRag`.

Include in `context_ready` / `RetryContext` as `ragGuideUrls` so stream retry reuses the same subset.

Trace: log `ragGuideUrls`, `rag_mode: "auto" | "subset"`, `subset_count` on `retrieval_complete`.

## Client data model

### Composer state (ephemeral)

```ts
// null = Auto
guideSourceSelection: string[] | null
```

- Initial: `null` (Auto).
- After **successful** turn: reset to `null`.
- On **edit user message**: restore `message.ragGuideUrls ?? null` into composer.
- On **regenerate**: use stored `ragGuideUrls` from the user turn being regenerated (same as images/history trim).

### Persisted on user message

Extend `Message` (`app/chat/types.ts`) + `coerceMessages` (`lib/chat-messages.js`):

```ts
ragGuideUrls?: string[]; // only when subset; omit when Auto
```

Written on the optimistic user bubble at send time. Stripped on variants if unused. Assistant messages do not need the field.

**No DB migration** — lives in existing `chats.messages` JSONB like `images`.

## Behavior matrix

| `preferredUrls` | `skipPreferredGuide` | `ragGuideUrls` | RAG pool |
|-----------------|----------------------|----------------|----------|
| 0 | * | * | No RAG |
| 1+ | true | * | Skipped (`web_skip_guide`) |
| 1+ | false | omit / Auto | All `preferredUrls` |
| 1+ | false | `[A, B]` | Only A and B (must be ⊆ preferred, indexed at retrieval time) |

Guide ingest before solve (`runGuideIngestForTurn`): pass **effective** RAG URLs for this turn (subset if set, else all `preferredUrls`), so we do not block send on indexing a guide the user did not select.

## Implementation phases

### Phase 1 — Server + types (no UI)

1. `coerceRagGuideUrls` + unit asserts in `scripts/check.mjs`.
2. `solve/route.ts`: compute `effectiveRagUrls`, wire RAG + cache key + `context_ready`.
3. `RetryContext` + `solve-stream.ts` type update.
4. `execute-chat-turn.ts`: accept `ragGuideUrls` from caller; include in POST body.

**Exit criteria:** `POST /api/solve` with `ragGuideUrls: [one url]` only returns chunks from that guide (verify via `/api/rag-eval` or admin traces).

### Phase 2 — Composer UI

1. New `app/chat/guide-source-strip.tsx` (or `guide-source-picker.tsx`).
2. Props: `preferredUrls`, `guideMeta`, `guideIndexState`, `selection`, `onChange`, `disabled`.
3. Mount in `composer-shell.tsx` above `.composer-inner` when `preferredUrls.length > 1`.
4. CSS in `globals.css`: `.composer-guide-source`, upward panel, focus rings, dark theme tokens per `docs/ui-theme.md`.

**Exit criteria:** Manual QA — multi-guide room, subset send, admin trace shows correct `guide_url` on chunks.

### Phase 3 — Turn lifecycle

1. `page.tsx` / `use-chat-turn.tsx`: state `guideSourceSelection`, reset after send, wire into `runTurn`.
2. Persist `ragGuideUrls` on user message in turn persist path.
3. Edit message: restore selection into composer.
4. Regenerate: read `ragGuideUrls` from user message; pass to `executeChatTurn`.
5. `guide-turn-ingest.ts`: filter `urlsNeedingIngest` by effective RAG URLs.

**Exit criteria:** Edit + retry keep subset; ingest does not run for deselected guides on that turn.

### Phase 4 — Polish

1. Optional chip on user bubble (debug/UX): small muted “From: Build FAQ” when subset — **only if** it does not clutter; otherwise skip for v1.
2. Admin: show `rag_mode` on solve_logs row if cheap.
3. Update `CLAUDE.md` + this doc status → **Shipped**.

## Touchpoints

| Area | File |
|------|------|
| Coerce subset | `lib/guide-urls.js` or new `lib/guide-source-selection.js` |
| RAG entry | `lib/guide-rag.ts` (`retrieveFromPreferredGuides` — no change if caller passes subset) |
| Solve orchestration | `app/api/solve/route.ts` |
| Turn POST body | `app/chat/execute-chat-turn.ts` |
| Deps | `app/chat/chat-turn-deps.ts` |
| Ingest gate | `app/chat/guide-turn-ingest.ts` |
| Message shape | `app/chat/types.ts`, `lib/chat-messages.js` |
| Composer | `app/chat/composer-shell.tsx`, new strip component |
| Styles | `app/globals.css` |
| Parent state | `app/page.tsx`, `app/chat/use-chat-turn.tsx` |
| Retry type | `app/chat/solve-stream.ts`, `app/chat/types.ts` (`RetryContext`) |
| Tests | `scripts/check.mjs` (coerce), optional `scripts/test-rag-subset.mjs` |

**No SQL changes** — `match_guide_chunks` already filters `guide_url = any(p_guide_urls)`.

## Edge cases

| Case | Behavior |
|------|----------|
| User selects subset but all selected are unindexed | Block send with toast; offer Auto or wait. |
| Selected guide fails mid-ingest | Same as today’s ingest fallback modal; subset may shrink to indexed only if user confirms. |
| Guide removed from room after message sent | Retry uses stored URLs; server strips unknown URLs; if none left → Auto or knowledge-only per existing miss path. |
| `preferredUrls` drops to 1 | Hide strip; force Auto. |
| Temporary chat | Same behavior (memory-only messages still store `ragGuideUrls`). |
| Anon | Full feature (no Storage dependency for selector itself). |

## Testing

1. **`npm run check`** — coerce helpers: subset ⊆ preferred, Auto normalization, message round-trip.
2. **Manual** — room with 2+ indexed guides; ask same question with Auto vs single-guide subset; compare admin RAG chunk `guide_url`s.
3. **Regenerate** — subset turn → Regenerate → same chunks pool (via `retryContext` + stored `ragGuideUrls`).
4. **Edit** — edit user message → composer shows prior subset.

## Teardown

Grep: `ragGuideUrls`, `guideSourceSelection`, `guide-source-strip`, `Guides · Auto`, `coerceRagGuideUrls`

Remove strip component, API field handling, message field coercion, cache key segment, this file.

## Decision log

| Date | Decision |
|------|----------|
| 2026-07-27 | Multi-select subset, not radio |
| 2026-07-27 | Per-message: composer resets to Auto after send; persist subset on user message for retry/edit |
| 2026-07-27 | Unindexed guides visible but not selectable |
| 2026-07-27 | No “fair share” across guides in Auto mode for v1 |
| 2026-07-27 | Show strip only when `preferredUrls.length > 1` |
| 2026-07-27 | New field `ragGuideUrls` on solve body (not overload `preferredUrls`) |
