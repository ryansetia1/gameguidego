# Chat persistence cutover fixes

**Status:** Planned  
**Audience:** Future agents and maintainers  
**Last updated:** 2026-07-22  
**Depends on:** [chat-persistence-refactor.md](./chat-persistence-refactor.md) Phase 2–3 (shipped)  
**Triggered by:** Code review of `92f9d048` → `5ec980c` (July 2026)

## Why this plan exists

Phase 2–3 introduced normalized tables (`chat_turns`, `chat_responses`,
`chat_turn_state`) and cut signed-in reads to normalized-only. The refactor is
architecturally sound, but the review found **data-loss and race paths** between
the client JSONB cache, fire-and-forget normalized sync, and server `after()`
saves. `pickRicherThread` was implemented and tested but never wired into the
read path, while `docs/plan/chat-persistence-refactor.md` claims it was.

This plan closes every review finding in small, shippable PRs without reopening
the page decomposition work.

---

## Review findings (source of truth)

| ID | Severity | Finding |
|----|----------|---------|
| F1 | **Critical** | Signed-in `openChat` uses `loadThreadMessages` only; pre-backfill chats open empty |
| F2 | **Critical** | Server `after()` reads normalized thread only; race with async `syncThreadFromMessages` |
| F3 | Required | `syncThreadFromMessages` errors swallowed (`.catch(() => {})`) |
| F4 | Required | Deploy order (SQL → backfill → code) not enforced or surfaced in UI |
| F5 | Required | Generic error path reverts to `priorMessages` and can overwrite a successful server save |
| F6 | Optional | `use-chat-turn.tsx` still ~890 lines; complexity relocated not reduced |
| F7 | Optional | `syncAllTurnsFromMessages` re-upserts every turn on each persist |
| F8 | Optional | `pickRicherThread` dead in app code despite plan doc claim |
| F9 | Optional | `retryContext: any` in `ChatTurnDeps` |
| F10 | Nit | Cosmetic indentation in `useChatTurn`; toast checkmark off brand voice |

---

## Product constraints (do not break)

- **No login wall.** Anon flow stays `localStorage`-only.
- **Temporary chat** stays memory-only.
- **Background completion** via `after()` must still survive client disconnect.
- **Variant history** (regenerate + nav) must survive refresh.
- **One PR per phase** below; each must pass `npm run check` and `npm run build`.

---

## Phase 0 — Deploy gate (ops, no app code)

**Fixes:** F4 (partial)

**Goal:** No user sees empty history because code shipped before data migrated.

### Steps

1. Apply `db/chat-threads.sql` on production Supabase.
2. Run `npm run backfill:chats:dry` and review counts.
3. Run `npm run backfill:chats`.
4. Run `npm run backfill:chats:verify` until mismatches = 0 (or document known exceptions).
5. Only then deploy app code that reads normalized-only.

### Exit criteria

- `backfill:chats:verify` reports 0 mismatches on prod (or a written exception list).
- Runbook recorded in this doc's [Deploy checklist](#deploy-checklist) section.

---

## Phase 1 — Wire the read path (F1, F8)

**Fixes:** F1, F8  
**Risk:** Low  
**Estimated diff:** ~80 lines

### Problem

`resolveThreadMessages` and `loadThreadMessages` return normalized rows or `[]`.
Legacy `chats.messages` JSONB is ignored on read even when it is richer
(e.g. variant nav the normalized rebuild has not caught up with).

### Changes

| File | Change |
|------|--------|
| `lib/chat-thread-persist.js` | Update `resolveThreadMessages(supabase, chat)` to fetch normalized **and** legacy JSONB (`select("messages")` or pass legacy from caller), return `pickRicherThread(normalized, legacy)` |
| `app/page.tsx` | `openChat`: call `resolveThreadMessages` instead of `loadThreadMessages`; pass `chat` row (re-add `messages` to `loadChats` select **or** one-off fetch in `openChat`) |
| `app/chat/use-chat-turn.tsx` | Poll / background-recovery paths: use `resolveThreadMessages` (or shared helper) instead of `loadThreadMessages` |
| `docs/plan/chat-persistence-refactor.md` | Align Phase 2 status text with actual wiring |

### Behaviour contract

```
signed-in read =
  pickRicherThread(
    fetchNormalizedThread(chatId),
    coerceMessages(chats.messages)   // legacy cache
  )
```

Keep `pickRicherThread` in `lib/chat-thread.js` (do not delete). Add one
`check.mjs` case: normalized empty + legacy non-empty → returns legacy.

### Exit criteria

- Open a chat that has JSONB only (simulate: skip backfill on one test row) → messages visible.
- Open a chat with normalized + legacy → richer source wins per existing heuristic.
- Regenerate 3×, refresh → variant nav still works.

---

## Phase 2 — Server save fallback (F2)

**Fixes:** F2  
**Risk:** Medium  
**Estimated diff:** ~60 lines

### Problem

`app/api/solve/route.ts` `after()` calls `fetchNormalizedThread` only. When
normalized is empty (sync lag, first deploy, sync failure), the server logs a
warning and **drops the assistant answer**.

### Changes

| File | Change |
|------|--------|
| `lib/chat-thread-persist.js` | Add `loadMessagesForServerMerge(supabase, chatId)`: try normalized; if empty or last turn has no user row, fall back to `chats.messages` JSONB |
| `app/api/solve/route.ts` | Use `loadMessagesForServerMerge` before `mergeAssistantIntoMessages`; on success call `persistAssistantResponse` (which syncs normalized + updates cache) |
| `lib/chat-persist.js` | Optional: extract shared "messages array ready for merge" helper if solve + client need the same shape |

### Behaviour contract

```
server after() merge source =
  normalized thread if it has the in-flight user turn
  else chats.messages JSONB cache
```

Do **not** skip `persistAssistantResponse` on JSONB fallback; the whole point
is to backfill normalized from the merged result.

### Exit criteria

- Simulate slow sync (delay `syncThreadFromMessages` in dev): server still saves answer.
- `after()` with JSONB-only chat: answer appears after refresh.
- No duplicate assistant rows (merge idempotency unchanged).

---

## Phase 3 — Client sync reliability (F3, F2 partial)

**Fixes:** F3, supports F2  
**Risk:** Low–medium  
**Estimated diff:** ~50 lines

### Problem

`persistChat` fires `void syncThreadFromMessages(...).catch(() => {})`. Failures
are invisible; normalized never populates; server and poll paths stay broken.

### Changes

| File | Change |
|------|--------|
| `app/chat/use-chat-turn.tsx` | Replace `.catch(() => {})` with `.catch((err) => console.warn("[chat-thread] sync failed", { chatId, err }))` |
| `app/chat/use-chat-turn.tsx` | **Before** `/api/solve` fetch (signed-in, non-temporary, has `activeId`): `await syncThreadFromMessages(supabase, activeId, optimistic)` so normalized has the user turn before server `after()` runs |
| `lib/chat-thread-persist.js` | Return structured `{ ok, reason, error }` from `syncThreadFromMessages` (already does); ensure callers log `reason` |

### ponytail ceiling

Awaiting sync before solve adds one round-trip latency at turn start. Acceptable
for correctness; upgrade path is tail-only upsert (Phase 5).

### Exit criteria

- Force sync failure (revoke insert policy in dev): console shows reason; client
  fallback `persistChat` still saves JSONB.
- Happy path: normalized row exists before solve returns (verify via admin trace
  or direct DB read).

---

## Phase 4 — Safe error revert (F5)

**Fixes:** F5  
**Risk:** Medium  
**Estimated diff:** ~40 lines

### Problem

On generic catch (not abort, not network-drop poll path), client calls
`persistChat(priorMessages)` which can overwrite a server-persisted answer.

### Changes

| File | Change |
|------|--------|
| `app/chat/use-chat-turn.tsx` | Before revert persist: one quick `resolveThreadMessages` (or poll once with `pollRecoveredMessages`); if server has a completed assistant for this turn, apply synced messages and **skip** revert |
| `lib/chat-persist.js` | Reuse `shouldApplySyncedMessages` / `pollRecoveredMessages` — no new heuristics |

### Behaviour contract

```
on error (signed-in, has activeId):
  loaded = resolveThreadMessages once
  if pollRecoveredMessages(optimistic, loaded):
    apply loaded; do not revert
  else:
    revert to priorMessages (current behaviour)
```

### Exit criteria

- Stream dies after server `after()` completes → UI shows answer, no revert.
- Stream dies before server completes → revert still works.
- Abort (Stop) still cancels without showing a ghost answer.

---

## Phase 5 — Performance tail upsert (F7, optional)

**Fixes:** F7  
**Risk:** Low  
**Estimated diff:** ~80 lines  
**Priority:** Defer until Phases 1–4 ship

### Problem

Every `syncAllTurnsFromMessages` upserts all turns. Long threads pay O(n) RTTs.

### Changes

| File | Change |
|------|--------|
| `lib/chat-thread-persist.js` | Add `syncTailTurn(supabase, chatId, messages, traceId)` that only upserts the last paired turn + prunes orphaned tail turns |
| `app/chat/use-chat-turn.tsx` | Use tail sync for mid-turn optimistic writes; full sync on edit/retry (truncation) and variant navigate |

### Exit criteria

- 20-turn chat: persist after new answer touches ≤2 turn rows (assert in dev log).
- Edit that drops turns still deletes orphaned `chat_turns` rows.

---

## Phase 6 — Hook cleanup (F6, F9, F10, optional)

**Fixes:** F6, F9, F10  
**Risk:** Low  
**Priority:** Defer; no user-facing behaviour change

### Changes

| Item | Change |
|------|--------|
| F6 | Split `use-chat-turn.tsx`: `use-turn-persist.ts` (persist + sync), `use-solve-stream.ts` (SSE parse), keep `runTurn` as thin orchestrator |
| F9 | Type `retryContext` in `app/chat/types.ts` |
| F10 | Fix indentation; change toast to "Steam connected" (no checkmark) |

### Exit criteria

- `use-chat-turn.tsx` under 400 lines.
- No new circular imports.

---

## Phase 7 — Integration test (all critical paths)

**Fixes:** Verification gap from review  
**Risk:** None  
**Estimated diff:** ~100 lines

### Add to `scripts/check.mjs` or new `scripts/chat-persist-integration.mjs`

| Scenario | Assert |
|----------|--------|
| Legacy-only read | `pickRicherThread([], legacy)` → legacy |
| Server merge from JSONB fallback | `loadMessagesForServerMerge` mock returns JSONB user row → merge succeeds |
| Sync-before-solve ordering | Documented contract test (mock timers if needed) |
| Error path no clobber | `shouldApplySyncedMessages` blocks revert when server ahead |

Keep tests dependency-free (no Supabase in CI unless env present). Pure-function
tests in `check.mjs` are enough for Phase 7 minimum.

---

## Suggested PR stack

| PR | Phase | Title (imperative) |
|----|-------|-------------------|
| 1 | 0 | Ops: apply chat-threads.sql and run backfill on prod |
| 2 | 1 | Fix signed-in chat read path with pickRicherThread fallback |
| 3 | 2 | Add JSONB fallback for server after() assistant persist |
| 4 | 3 | Await normalized sync before solve; log sync failures |
| 5 | 4 | Skip error revert when server already persisted the answer |
| 6 | 5 | Upsert tail turn only on routine persist (optional) |
| 7 | 6 | Split use-chat-turn and tighten types (optional) |
| 8 | 7 | Add chat persist contract tests to npm run check |

Phases 1–4 are **required before calling cutover complete**. Phases 5–7 are
improvements.

---

## Deploy checklist

```
[ ] db/chat-threads.sql applied on target Supabase project
[ ] npm run backfill:chats:dry   — review output
[ ] npm run backfill:chats       — populate chat_turns / chat_responses / chat_turn_state
[ ] npm run backfill:chats:verify — 0 mismatches (or documented exceptions)
[ ] Deploy app with Phase 1+2+3+4 fixes
[ ] Smoke: signed-in user opens old chat → history visible
[ ] Smoke: new question → refresh → answer persists
[ ] Smoke: regenerate 2× → refresh → variant nav shows 3 variants
[ ] Smoke: kill network mid-answer → "Continuing process..." → answer recovers
```

---

## Files touched (summary)

| File | Phases |
|------|--------|
| `lib/chat-thread-persist.js` | 1, 2, 5 |
| `lib/chat-thread.js` | 1 (tests only) |
| `lib/chat-persist.js` | 2, 4, 7 |
| `app/api/solve/route.ts` | 2 |
| `app/page.tsx` | 1 |
| `app/chat/use-chat-turn.tsx` | 1, 3, 4, 5, 6 |
| `app/chat/types.ts` | 6 |
| `scripts/check.mjs` | 1, 7 |
| `docs/plan/chat-persistence-refactor.md` | 1 (doc sync) |
| `CLAUDE.md` | After Phase 4 ships (read path + server fallback behaviour) |

---

## Exit criteria (plan complete)

- [ ] F1–F5 resolved and verified via deploy checklist.
- [ ] `pickRicherThread` wired; not dead code.
- [ ] Server `after()` never silently drops an answer when JSONB has the user turn.
- [ ] Client sync failures are logged; sync completes before solve on happy path.
- [ ] Error revert does not clobber a server-completed answer.
- [ ] `npm run check` and `npm run build` pass.
- [ ] `CLAUDE.md` and `chat-persistence-refactor.md` match shipped behaviour.

---

## See also

- [chat-persistence-refactor.md](./chat-persistence-refactor.md) — original layered refactor
- [page-decomposition.md](./page-decomposition.md) — UI split (complete; out of scope here)
