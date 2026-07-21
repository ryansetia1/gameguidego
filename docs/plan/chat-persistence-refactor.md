# Chat persistence refactor plan

**Status:** Active (Phase 0 partial)  
**Audience:** Future agents and maintainers  
**Last updated:** 2026-07-22

## Why this plan exists

GameGuideGo is moving from "prototype you can demo" to **daily-driver** reliability.
The FF8 variant bug (July 2026) showed that chat data is easy to lose or fail to
render even when the backend succeeded:

- Four `trace_events` rows finished successfully for the same regenerate.
- Supabase `chats.messages` held two variants with `activeVariantIndex`.
- The UI showed no variant navigator after reload because `coerceMessages` dropped
  `variants` / `activeVariantIndex`.

The JSONB-per-chat model is not wrong for this product, but the **write path,
load path, and observability** around it are under-specified. This plan fixes that
in layers without a big-bang rewrite.

---

## Product constraints (do not break)

- **No login wall.** Signed-out users keep full access; anon uses `localStorage`
  (`lib/local-games.js`, cap 20 games).
- **One saved row per game** in the sidebar/library mental model.
- **Temporary chat** stays memory-only (no URL/session persistence).
- **Background completion** must survive client disconnect (`after()` in
  `/api/solve`).
- **Variant history** (regenerate) is a first-class feature, not an afterthought.

---

## Current architecture

```
chats (1 row per saved game)
├── metadata: game, platform, cover_url, preferred_guide_urls, ...
└── messages: jsonb[]          ← entire thread, full replace each turn
    ├── { role: "user", content, images? }
    └── { role: "assistant", content, sources, highlights, variants[], activeVariantIndex }

Parallel (not joined to chat rows today):
├── solve_logs      — per-turn pipeline telemetry
├── llm_calls       — per model/embed call
└── trace_events    — granular trace_id timeline (admin)
```

**Writers today (problem):**

| Writer | When | What |
|--------|------|------|
| Client `persistChat` | Every turn, edit, variant navigate | Full `messages` blob |
| Server `after()` in `/api/solve` | Background finish | Read blob, patch last message, write back |

Two writers on one JSON document without versioning → races, lost variants, and
poll logic that cannot detect regenerate completion (`msgs.length` unchanged).

**Readers today:**

| Path | Coercion |
|------|----------|
| `openChat`, `loadChats`, background poll | `coerceMessages()` in `page.tsx` |
| Anon | Same shape in `localStorage` |

Any new `Message` field must be added to the TypeScript type **and** `coerceMessages`
or it silently disappears on load.

---

## Target principles

1. **One canonical writer per concern.** UI may be optimistic; durable state has
   a single owner.
2. **Schema at the boundary.** Load/save paths validate shape; DB JSON is untrusted.
3. **Variants are append-only.** Regenerate adds a row or array entry; never
   overwrites history unless the user explicitly deletes a turn.
4. **Observability links to chat.** `trace_id` on each assistant response ties
   admin traces to what the user sees.
5. **Anon parity.** Whatever we store in Supabase must have a plausible
   `localStorage` mirror or a deliberate "signed-in only" cut.

---

## Phased roadmap

### Phase 0 — Stop the bleeding (days)

**Goal:** Variant UI works reliably on the existing schema.

| Item | Status | Notes |
|------|--------|-------|
| `coerceMessages` preserves `variants` + `activeVariantIndex` | Done | `lib/chat-messages.js` |
| Optimistic regen snapshots prior answer into `variants` before placeholder | Done | `snapshotAssistantVariants()` |
| Background poll detects regen completion | Done | `pollRecoveredMessages()` |
| `npm run check` covers variant coercion | Done | FF8-shaped fixture in `scripts/check.mjs` |
| Manual verify: reload FF8 chat shows `N / M` navigator | Pending | Chat id `a80bc755-7323-4486-9766-cf8ae698f0d7` |

**Exit criteria:** Reload, sidebar reopen, and background poll all preserve variant
navigator for chats that have `variants.length > 1` in DB.

---

### Phase 1 — Stabilize JSONB model (1–2 weeks)

**Goal:** Daily use without silent data loss on the current table.

#### 1a. Single writer for durable messages

**Status:** Done (July 2026)

**Decision:** Server `after()` owns the final assistant message when `chatId` +
auth token are present. Client `persistChat` writes user turns and optimistic
placeholders only; on SSE `result`, client updates React state then polls for the
server write (`lib/chat-persist.js#pollUntilMessagesRecovered`). Client falls back
to `persistChat` if the poll times out.

Implementation: `lib/chat-persist.js` (`serverOwnsAssistantPersist`,
`mergeAssistantIntoMessages`, `buildTurnMessagesWithAssistant`).

```
Client                          Server after()
  │                                  │
  ├─ persist user + "Writing..."     │
  ├─ POST /api/solve ───────────────►│
  │                                  ├─ generate
  │◄──────────── SSE result ─────────┤
  ├─ setMessages (UI only)           ├─ read messages, append/replace assistant
  │                                  └─ UPDATE chats (canonical)
  └─ poll until last ≠ "Writing..."  │
```

**Fallback:** If anon or no `chatId`, client remains sole writer (unchanged).

**Files:** `app/page.tsx` (`runTurn`, `persistChat`), `app/api/solve/route.ts`.

#### 1b. Background poll detects regenerate completion

**Status:** Done (Phase 0) — `pollRecoveredMessages()` in `lib/chat-messages.js`,
used in network-drop recovery and post-success server sync poll.

#### 1c. Message coercion tests

**Status:** Done — `scripts/check.mjs` (Phase 0 + Phase 1 merge tests).

- Round-trip `variants` + `activeVariantIndex`
- Strip unknown roles; keep valid assistant variant payloads
- `variants: []` falls back to snapshot on regen (use `.length` not `??`)

#### 1d. Align server variant shape

**Status:** Done (Phase 0) — `buildAssistantVariantBody()`; variants array has no `role`.

**Exit criteria:**

- Regenerate 5×, refresh, still see 5 variants.
- Kill network mid-regenerate, reopen chat, answer appears within poll window.
- No `coerceMessages` field regressions caught by `npm run check`.

---

### Phase 2 — Hybrid tables (2–4 weeks)

**Status:** Done (July 2026) — `db/chat-threads.sql`, `lib/chat-thread.js`,
`lib/chat-thread-persist.js`. Uses `chat_id` → `chats.id` (no `chat_threads` table
until Phase 3). Server `persistAssistantResponse` writes **all** variant rows from
`variantRowsFromPersistedAssistant`, rebuilds `chats.messages` cache; `openChat` uses
`pickRicherThread` via `resolveThreadMessages`; poll sync uses `shouldApplySyncedMessages`
so incomplete normalized rows never clobber local variant nav.

**Goal:** Canonical history for turns and variants; JSONB becomes a cache.

This is the sweet spot for a serious daily-driver **without** rewriting all of
`page.tsx` at once.

#### Target schema

```sql
-- Thread header (mostly what chats is today, minus messages blob)
create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game text not null,
  platform text not null default '',
  preferred_guide_urls text[] not null default '{}',
  cover_url text not null default '',
  release_year text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per user question in order
create table public.chat_turns (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads (id) on delete cascade,
  turn_index int not null,           -- 0-based order within thread
  user_content text not null,
  user_images text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (thread_id, turn_index)
);

-- One row per assistant answer variant (append on regenerate)
create table public.chat_responses (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references public.chat_turns (id) on delete cascade,
  variant_index int not null,        -- 0 = first answer, 1+ = regenerate
  content text not null,
  sources jsonb,
  highlights jsonb,
  spoilers jsonb,
  pipeline_type text,
  trace_id text,                     -- links to trace_events / solve_logs
  created_at timestamptz not null default now(),
  unique (turn_id, variant_index)
);

-- Which variant is active in the UI for each turn
create table public.chat_turn_state (
  turn_id uuid primary key references public.chat_turns (id) on delete cascade,
  active_variant_index int not null default 0
);

-- Optional: keep messages jsonb on chat_threads as denormalized UI cache
alter table public.chat_threads
  add column if not exists messages_cache jsonb;
```

**RLS:** Same pattern as today — `user_id = auth.uid()` on `chat_threads`; child
tables gated through `thread_id` join or `security definer` RPCs.

#### Write path (Phase 2)

1. User sends → `INSERT chat_turns` + optimistic UI.
2. Solve completes → `INSERT chat_responses` (variant_index = count existing for turn).
3. Rebuild `messages_cache` from turns + responses (server-side function).
4. Client may still read `messages_cache` until UI reads normalized tables directly.

#### Read path (migration bridge)

```ts
// lib/chat-thread.ts (new)
export async function loadThreadMessages(threadId: string): Promise<Message[]>
export async function appendResponse(turnId: string, variant: ResponsePayload): Promise<void>
```

`openChat` calls `loadThreadMessages` if normalized rows exist, else falls back
to legacy `chats.messages`.

#### Anon bridge

Keep `localStorage` JSON until Phase 3. Shape matches `Message[]` built from
normalized tables so client code converges.

**Exit criteria:**

- New chats write only to normalized tables (+ cache).
- Variant history survives any client-only bug in `coerceMessages` (DB rows are source of truth).
- Admin can query: "all responses for trace_id X".

---

### Phase 3 — Legacy migration & JSONB retirement (1–2 weeks)

**Status:** In progress (July 2026) — `scripts/backfill-chat-threads.mjs`,
`lib/chat-thread-audit.js`, `backfillChatFromMessages` / `verifyChatThread`.
`resolveThreadMessages` reads normalized when rows exist (legacy JSONB fallback
only for not-yet-backfilled chats). Run `npm run backfill:chats` with service role.

**Goal:** Move existing `chats` rows into `chat_threads` + children; drop reliance on blob.

1. **Backfill script** (SQL or one-off Node):
   - For each `chats` row, parse `messages[]`.
   - Pair user/assistant into `chat_turns` + `chat_responses`.
   - Map nested `variants[]` to multiple `chat_responses` rows per turn.
   - Set `active_variant_index` from `activeVariantIndex`.

2. **Dual-read period:** Compare `messages` vs rebuilt cache; log mismatches.

3. **Cutover:** `chats` table renamed `chats_legacy` or dropped after verification.

4. **localStorage:** Optional cap-aware mirror of `messages_cache` only.

**Exit criteria:** Zero reads from `messages` jsonb in production code paths.

---

### Phase 4 — UI module split (parallel-friendly)

See [page-decomposition.md](./page-decomposition.md). Not blocked on Phase 2, but
easier once `lib/chat-thread.ts` owns persistence instead of 400 lines inside
`page.tsx`.

---

## What we are NOT doing (yet)

| Idea | Why defer |
|------|-----------|
| Full Slack-style message pagination | Threads are short; one game = one scroll |
| Realtime sync across tabs | Poll + single writer is enough for solo daily use |
| CRDT / OT for edits | Edit/retry truncates turns; document model still OK |
| Storing full LLM prompts in chat rows | Already in `llm_calls` (insert-only, admin) |

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Migration corrupts variant history | Dry-run backfill on staging; keep `chats_legacy` 30 days |
| Anon/localStorage diverges from Supabase | Single `Message[]` builder function shared by both |
| `page.tsx` refactor breaks hooks order | Extract pure functions first; components second |
| Phase 2 scope creep | Ship `chat_responses` only for **new** regens first; backfill later |

---

## Success metrics

| Metric | Target |
|--------|--------|
| Variant loss after reload | 0 reports |
| Regenerate recovery after network drop | < 30s via poll |
| `coerceMessages` regression | Covered by `npm run check` |
| Trace → visible answer link | `trace_id` on every `chat_responses` row (Phase 2+) |
| `page.tsx` line count | < 3000 after Phase 4 (from ~4800) |

---

## Implementation order (checklist)

```
Phase 0  [x] coerceMessages variants (lib/chat-messages.js)
         [x] optimistic variant snapshot on regen
         [x] background poll regen detection
         [x] check.mjs message coercion tests
         [x] server variant shape (no role in variants[])
         [ ] manual QA on FF8 chat

Phase 1  [x] single canonical writer (lib/chat-persist.js)
         [x] post-success pollUntilMessagesRecovered
         [x] mergeAssistantIntoMessages shared server/client shape
         [x] check.mjs merge + serverOwnsAssistantPersist tests

Phase 2  [x] SQL migration files in db/ (chat-threads.sql)
         [x] lib/chat-thread.js + lib/chat-thread-persist.js
         [x] solve/route.ts writes chat_responses + trace_id
         [x] bridge loader in openChat (resolveThreadMessages)
         [x] apply db/chat-threads.sql on Supabase project
         [ ] manual QA on FF8 chat

Phase 3  [x] backfill script (scripts/backfill-chat-threads.mjs)
         [x] dual-read validation (lib/chat-thread-audit.js, verifyChatThread)
         [x] canonical read from normalized (loadThreadMessages / resolveThreadMessages)
         [x] run backfill on all production chats (8/8, 0 mismatches)
         [x] retire chats.messages reads (signed-in: normalized only; JSONB write-only cache; anon localStorage)

Phase 4  [ ] page decomposition (see sibling doc)
```

---

## Related docs

- [audit-send-to-answer.md](../audit-send-to-answer.md) — solve pipeline bugs
- [troubleshooting.md](../troubleshooting.md) — Steam link, auth edge cases
- `CLAUDE.md` — live architecture contract (update when each phase ships)
