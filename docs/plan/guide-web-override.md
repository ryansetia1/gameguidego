# Skip guide — web search toggle

**Status:** Planned — not implemented (July 2026)  
**Audience:** Future agents implementing or removing this feature  
**Last updated:** 2026-07-25  
**Supersedes:** earlier draft `guide-web-supplement.md` (supplement/combine model — **wrong intent**, deleted)  
**Related:** `app/api/solve/route.ts`, `lib/guide-rag.ts`, `lib/guide-hints.js`, `lib/chat-message-ui.js`, `app/composer-extras.tsx`

## Purpose

A player can attach a preferred guide (PDF, GameFAQs, pasted URL) but **already know
that guide** and ask about something **outside** it — patches, meta, side content, or
anything the PDF does not cover.

Today, when RAG hits (`skipWebSearch: true`), the app answers **from the guide only**
and never runs web search. The guide becomes a cage even though the user still wants it
**attached** for other turns.

**This feature:** a per-turn toggle that means **skip my guide this message — search the
web instead.** The guide stays on the game card; only retrieval for *this turn* ignores it.

**This doc does not change runtime behaviour until implementation lands.**

---

## Problem (correct framing)

| Situation | Today | What the player wants |
|-----------|-------|------------------------|
| Guide attached, RAG **hit** | Guide only; no web | Web + knowledge; **ignore guide** this turn |
| Guide attached, RAG miss | Web only | Same (already works) |
| Guide attached, toggle OFF | Unchanged | Guide when hit; web when miss |

The gap is **row 1**: user has a guide but does **not** want it used for this question.

**Not the goal:** combine guide + web on the same turn (supplement). That was an earlier
misread; do not implement `rag_supplemented` unless product explicitly asks later.

---

## Feature contract (one sentence)

**Toggle ON = skip preferred-guide RAG for this turn; run tiered web search + model
knowledge only.** Guide URLs stay attached for the room.

**Toggle OFF = current behaviour (unchanged).**

---

## Semantics

| Toggle | Guide attached? | RAG runs? | Web runs? | Sources in prompt | Typical `pipelineType` |
|--------|----------------|-----------|-----------|-------------------|------------------------|
| OFF | No | — | Yes | web | `web` |
| OFF | Yes, hit | Yes | No | guide | `rag` |
| OFF | Yes, miss | Yes | Yes | web | `fallback_web` |
| **ON** | **Yes** | **No (skipped)** | **Yes** | **web only** | **`web`** or **`web_skip_guide`** |
| ON | No | — | Yes | web | `web` *(toggle no-op)* |

Model knowledge always participates in `summarize()`.

**Why skip RAG entirely (not "run but discard"):** saves embed query + DB retrieval
latency and cost; user intent is explicit.

**Rewrite path:** when toggle ON, use normal web rewrite (`forRag: false`), not
`REWRITE_RAG_INSTRUCTION` — we are not searching inside the guide.

---

## User story

> I uploaded a Suikoden II PDF. I know the walkthrough. This turn I want to ask about
> a 2024 fan patch — search the web, don't pull chunks from my PDF.

Guide remains on the card for the next "where is the fire rune?" question with toggle OFF.

---

## UI / copy (brand voice)

| Element | Copy |
|---------|------|
| Toggle label | **Search web instead** |
| Toggle help | Skips your guide for this message and checks the web. |
| Source chip | `Web search` (not "guide + web") |
| Toast (optional) | Skipped your guide and searched the web. |
| Answer info `?` | `web` mode — same as no-guide web answers |

**Visibility:** only when `preferredUrls.length > 0`. Disabled/hidden when no search API keys.

**Persistence:** default OFF. Recommend `sessionStorage` `gg:skip-guide-web` per open thread
(so refresh keeps "research mode" without cross-game bleed).

**API field (suggested):** `skipPreferredGuide: boolean` (not `alsoSearchWeb` — that name
implies addition and will confuse future agents).

---

## Implementation plan

### Phase 1 — API + solve path

1. **`POST /api/solve`** — add `skipPreferredGuide?: boolean`, default `false`.
   Coerce: `Boolean(body.skipPreferredGuide)`.

2. **`app/api/solve/route.ts`** — early branch when `preferredUrls.length && skipPreferredGuide`:

   ```
   if (preferredUrls.length && skipPreferredGuide) {
     // Same path as "no preferred guide" for retrieval
     forRag = false;   // web rewrite, not RAG rewrite
     // DO NOT call retrieveFromPreferredGuides
     if (hasSearchProvider) {
       sendEvent "Searching the web...";
       sources = await tieredWebSearch(searchQuery);
       pipelineType = sources.length ? "web_skip_guide" : "knowledge_only";
     } else {
       pipelineType = "knowledge_only";
     }
     guideHint = guideSkippedForWebHint();  // optional toast
   } else if (preferredUrls.length) {
     // existing RAG branch unchanged
   } else {
     // existing no-guide branch unchanged
   }
   ```

3. **`lib/solve-log.ts`** — add `"web_skip_guide"` to `pipelineType` union (optional but
   useful for admin: "had guide, user skipped"). Display label can still be "Web search".

4. **`lib/guide-hints.js`** — `guideSkippedForWebHint()` →
   `Skipped your guide and searched the web.`

5. **`lib/prompt.js`** — **no change required.** Without `preferred: true` sources, the
   preferred directive in `buildPrompt()` does not activate.

6. **Trace** — `skipPreferredGuide: true` on retrieval events; no `ragChunks`.

### Phase 2 — Client

1. State `skipPreferredGuide` → body in `execute-chat-turn.ts`.
2. Toggle in `composer-extras.tsx` (+ menu), props via `composer-shell.tsx` / `page.tsx`.
3. Retry uses **current** toggle state (not frozen), same as other per-turn flags.

### Phase 3 — Checks

1. `scripts/check.mjs` — hint + optional `pipelineSourceLabel("web_skip_guide")`.
2. Admin traces — map `web_skip_guide` → "Web search (guide skipped)" if raw type shown.

### Phase 4 — Ship docs

Update status → **Shipped**; `CLAUDE.md` + `docs/plan/README.md`.

---

## Files touched

| File | Change |
|------|--------|
| `app/api/solve/route.ts` | Early skip branch, `forRag` when skipped |
| `lib/solve-log.ts` | `web_skip_guide` union member |
| `lib/guide-hints.js` | Skip hint + toast |
| `lib/chat-message-ui.js` | Optional label for `web_skip_guide` |
| `app/chat/execute-chat-turn.ts` | Body field |
| `app/composer-extras.tsx` | Toggle UI |
| `app/chat/composer-shell.tsx` | Props |
| `app/page.tsx` | State + `sessionStorage` |
| `scripts/check.mjs` | Asserts |
| `CLAUDE.md`, `docs/plan/README.md`, this file | Docs |

**Not changed:** `lib/guide-rag.ts`, ingest, bundle panel, `buildPrompt` preferred directive.

---

## Teardown / removal guide

Grep until zero: `skipPreferredGuide`, `web_skip_guide`, `guideSkippedForWebHint`,
`Search web instead`, `gg:skip-guide-web`

| Step | File | Remove |
|------|------|--------|
| 1–4 | Client files | Toggle + state + body field |
| 5 | `app/api/solve/route.ts` | Skip branch + parse |
| 6 | `lib/guide-hints.js` | Hint |
| 7 | `lib/solve-log.ts` | Union member |
| 8 | `scripts/check.mjs` | Asserts |
| 9 | Docs | CLAUDE, README, this file → **Removed** banner |

Post-removal: guide attached + question → RAG hit → guide only (no web unless miss).

No DB migration. Historical `web_skip_guide` in message metadata is inert.

---

## Guardrails

1. **Default OFF** — zero behaviour change for existing users.
2. **Guide stays attached** — only retrieval skipped; do not remove `preferredUrls` from chat.
3. **Fail-open** — web empty → `knowledge_only` + existing hints.
4. **No login wall** — anon + signed-in.
5. **Cheaper than supplement** — no RAG/embed on skipped turns.

---

## Non-goals (v1)

- Guide + web on the same turn (supplement / `rag_supplemented`).
- Keyword intent ("cari di internet") without toggle.
- Removing guide from game card when toggle ON.
- Web-only mode when guide not attached (already default).

---

## Open questions

1. **`pipelineType`:** reuse `web` vs new `web_skip_guide` for admin? (Recommend new type
   for traces; UI label stays "Web search".)
2. **Toast every turn** vs first time only when toggle ON?
3. **Ingest:** client may still run background ingest for attached guide — OK, unrelated to solve.

---

## Success criteria

| Signal | Target |
|--------|--------|
| Toggle ON + guide attached | Trace has web sources, **no** `ragChunks` |
| Toggle OFF + RAG hit | Unchanged — guide only |
| User story | Patch/meta question does not cite PDF chunks |

---

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-25 | Document only | Plan before code |
| 2026-07-25 | Toggle not keywords | Deterministic |
| 2026-07-25 | **Override not supplement** | User clarified: already knows guide, asks outside it |
| 2026-07-25 | Skip RAG call entirely | Cost + clear intent |
| 2026-07-25 | `skipPreferredGuide` API name | `alsoSearchWeb` wrongly implies additive |
| 2026-07-25 | Deleted supplement draft | Avoid wrong implementation |

When shipped, update status to **Shipped**.
