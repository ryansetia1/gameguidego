# Player style memory (structured profile)

**Status:** Experimental — **shipped** (July 2026)  
**Runtime (planned):** Opt-in for signed-in users only. Daily incremental summarize +
manual **Update now**. Structured JSON injected into `buildPrompt()` — **not** full chat RAG.

## Understanding summary

1. **What:** "Learn my style" — the app learns how a signed-in player asks questions and
   (optionally) remembers per-game progress notes, then adapts answer tone and length.
2. **Why:** Answers feel more personal without the player repeating preferences every session.
3. **Who:** Signed-in users only (account benefit, RLS-scoped, cross-device sync).
4. **Scope:** **Hybrid** — global style card + per-game fact notes.
5. **Control:** **Opt-in** (off by default) + **transparent editable** profile section.
6. **Non-goals (v1):** Anon users; deep personality profiling; raw dump-all-chats RAG;
   replacing the existing 5-turn in-session history.

## Assumptions

- Users who opt in understand the app learns from their chat text.
- Style signals stabilize after ~5–10 user messages; earlier summarize is noise.
- Wrong inferences will happen; editable UI is the safety net.
- 24h staleness for style is acceptable; short-term context stays in existing turn history.
- Temporary chats are excluded from the message counter.
- Disabling the feature clears all stored memory (user-aware, clean reset).

## Decision log

| Decision | Choice | Alternatives | Why |
|----------|--------|--------------|-----|
| Primary goal | Answer style (A) | Full personality model | Directly felt, lower risk |
| Secondary | Per-game facts (B) | Required from day one | Nice-to-have; incremental |
| Audience | Signed-in only | Anon + localStorage | Sync, RLS, account benefit |
| Transparency | Opt-in + editable profile | Silent learning | Trust + cost control |
| Memory scope | Hybrid global + per-game | Global only / per-game only | Style consistent; facts isolated |
| Storage approach | Structured profile | Full chat RAG | Cheaper, auditable, fail-open |
| Update cadence | Daily cron + Update now | Per-turn / per-session | Predictable cost |
| Long history | Incremental merge | Re-summarize full dump | Input size stays bounded |
| Thresholds | 5 = draft, 10 = full | 10 only / immediate | Early value without garbage profiles |
| Disable | Clear memory + reset counter | Keep draft on re-enable | Clean, privacy-aligned |
| UI surface | `/profile` only | Game card chips | Keeps chat UI uncluttered |

## State machine

```
OFF ──enable──► COLLECTING (0–4 msgs) ──5──► DRAFT (5–9) ──10──► FULL (10+)
  ▲                  │ no inject          │ soft inject      │ full inject
  │                  │ progress bar       │ draft label      │ daily refresh
  └──disable─────────┴────────────────────┴──────────────────┘
       (confirm → wipe memory + reset counter)
```

| Tier | User messages since opt-in | Prompt inject | Summarize |
|------|---------------------------|---------------|-----------|
| `collecting` | 0–4 | None | No |
| `draft` | 5–9 | Soft style hints | Yes (first at 5, then daily / Update now) |
| `full` | 10+ | Full style directive | Yes (daily / Update now) |

**Counter:** count **user messages** only (not assistant turns), across all non-temporary
chats since `player_memory_enabled_at`.

## Data model

### `user_metadata` (small, synced)

```json
{
  "player_memory_enabled": false,
  "player_memory_enabled_at": "2026-07-23T10:00:00Z",
  "player_style": {
    "version": 1,
    "tier": "collecting",
    "messageCount": 7,
    "lastSummarizedAt": "2026-07-23T03:00:00Z",
    "style": {
      "answerLength": "short",
      "tone": "casual",
      "language": "id",
      "detailLevel": "steps",
      "notes": ["Prefers numbered steps", "Dislikes filler"]
    }
  }
}
```

`notes` capped at 5 bullets server-side.

### Table `player_game_memory`

```sql
-- db/player-game-memory.sql (to be written at implementation)
create table public.player_game_memory (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_key text not null,          -- normalized game name
  platform text not null default '',
  progress text,
  notes text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, game_key, platform)
);
-- RLS: user_id = auth.uid() for all operations
```

Per-game rows are shown and edited in `/profile` under **Game notes**.

## Summarize pipeline

### Triggers

| Trigger | When | Guards |
|---------|------|--------|
| **Milestone** | `messageCount` hits 5 (first draft) | `enabled`, background via `after()` |
| **Milestone** | `messageCount` hits 10 (upgrade to full) | Re-summarize with same job |
| **Daily cron** | 03:00 UTC (configurable) | `enabled`, `messageCount >= 5`, new chats since `lastSummarizedAt` |
| **Update now** | User taps button in `/profile` | `enabled`, `messageCount >= 5`, 1h cooldown |

### Input (incremental merge — not full history dump)

Each summarize job sends **one** Gemini call (`kind: memory_summarize` in `llm_calls`):

1. Existing `player_style` JSON + `player_game_memory` rows.
2. **Delta:** user messages from chats with `updated_at > lastSummarizedAt` (cap 50 messages).
3. System instruction: update the card; drop stale items; max 5 style bullets; output strict JSON.

Chats already live in `public.chats` (and `chat_turns` when normalized) — no separate dump file.

### Output schema (LLM → server)

```json
{
  "style": {
    "answerLength": "short",
    "tone": "casual",
    "language": "id",
    "detailLevel": "steps",
    "notes": ["…"]
  },
  "games": [
    {
      "gameKey": "resident-evil-0",
      "platform": "GameCube",
      "progress": "Chapter 2",
      "notes": ["Often stuck on puzzles"]
    }
  ]
}
```

Server validates, clamps, upserts. User manual edits between runs are preserved unless the
summarize explicitly replaces a field (ponytail: v1 can use "remote wins on summarize for
auto fields, user-pinned bullets skip overwrite" if edit conflicts become an issue).

### Fail-open

- Summarize error → keep last good memory; no user-facing error unless **Update now**.
- Missing memory → solve path unchanged (same as today).
- Target added latency on `/api/solve`: **0 ms** (summarize never blocks solve).

## Prompt injection (`lib/prompt.js`)

New block after `playerBlock`, only when `player_memory_enabled` and tier ≥ draft.

**Draft (5–9):**

```
Player style (early draft, use as a soft hint only):
- Prefers short answers
- Usually writes in Indonesian
Do not change factual game guidance to match these hints.
```

**Full (10+):**

```
Player style (learned from past chats):
- Prefers short, step-by-step answers
- Usually writes in Indonesian
- Likes direct tone, no filler
Adapt answer length and tone accordingly. Do not invent facts about the player.
```

**Per-game** (when a `player_game_memory` row exists for current game + platform):

```
What we know about this player in this game:
- Progress: Chapter 2
- Often stuck on puzzles
```

Wire from `/api/solve` after loading user session (same path as `playerName`).

## UI & copy (`/profile`)

### Toggle

- **Label:** `Learn my style`
- **Helper (off):** `Tailor answer length and tone to how you ask questions. Off by default.`
- **Disable confirm:** `Turn off and clear what we've learned?` (danger)

### Collecting (0–4)

- Progress: `{{n}} / 10 questions`
- Banner: `Still learning. This kicks in after 10 questions across your chats.`
- **Update now:** disabled — `Needs 5 questions first ({{n}}/5)`

### Draft (5–9)

- Progress bar to 10; section headers include `(draft)`.
- **Update now:** enabled (1h cooldown).
- Toast at 5: `Early style draft ready. Check your profile.`

### Full (10+)

- No progress bar; banner: `Style memory active. Updates daily.`
- Toast at 10 (once): `Style memory is on. Answers will adapt to you.`
- **Last updated:** timestamp from `lastSummarizedAt`

### Actions

| Control | Behavior |
|---------|----------|
| Remove (per bullet) | Delete one style note or game note row |
| Update now | `POST /api/player-memory/refresh` |
| Clear style memory | Wipe cards, keep toggle ON and counter (or confirm full reset) |

Profile menu chip while collecting: `Learning {{n}}/10`.

## API (planned)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/player-memory/refresh` | POST | Manual + shared summarize handler (auth bearer) |
| `/api/cron/player-memory` | GET | Daily batch (Vercel cron secret) |

`messageCount` increments in the existing chat persist path when memory is enabled and the
saved message is a user turn in a non-temporary chat.

## Cost estimate (rough)

- ~1 Gemini Flash call per opt-in user per day (skip if no new messages).
- Update now: same call, max once per hour per user.
- vs per-turn memorize: ~30× cheaper at 10 turns/day.

## Non-functional requirements

| Area | Target |
|------|--------|
| Solve latency | 0 ms added (async summarize only) |
| Memory size | ~300 tokens global + ~100 tokens per active game |
| Privacy | RLS per user; disable wipes data; no cross-user reads |
| Reliability | Fail-open on all summarize errors |

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Wrong style inference | Editable bullets; draft tier uses soft inject |
| Stale progress (24h) | Existing 5-turn history covers immediate context |
| Summarize overwrites user edits | v1: manual removes persist; consider `pinned` flag later |
| Cost from spam refresh | 1h cooldown on Update now |
| Creepy "it knows me" | Opt-in, transparent card, clear disable |

## Implementation checklist

### Phase 0 — Schema & types

- [ ] `db/player-game-memory.sql` + RLS
- [ ] `lib/player-memory.js` — coerce tier, counters, style shape
- [ ] Extend profile metadata helpers in `lib/profile.js`

### Phase 1 — Summarize job

- [ ] `lib/player-memory-summarize.ts` — incremental merge prompt + parse
- [ ] `POST /api/player-memory/refresh`
- [ ] `GET /api/cron/player-memory` + `vercel.json` cron
- [ ] `llm_calls` kind `memory_summarize`

### Phase 2 — Counter & milestones

- [ ] Increment `messageCount` in chat persist (signed-in, enabled, non-temporary)
- [ ] Fire first summarize at 5, tier bump at 10 (`after()`)
- [ ] Toasts via existing snackbar

### Phase 3 — Prompt wire

- [ ] Load memory in `/api/solve`
- [ ] `buildPrompt({ playerMemory, playerGameMemory })` blocks
- [ ] Fail-open if load fails

### Phase 4 — Profile UI

- [ ] Toggle + confirm disable in `app/profile/page.tsx`
- [ ] Progress bar, style card, game notes, Update now, Clear
- [ ] Profile menu chip while collecting

### Phase 5 — Polish

- [ ] `npm run check` fixtures for coerce + tier logic
- [ ] Admin trace: log memory tier on `solve_logs` (optional)
- [ ] Update `CLAUDE.md` when shipped

## Future (out of scope v1)

- Full chat RAG for ad-hoc "remember when I asked about X" retrieval
- Weekly full re-summarize for drift correction
- `pinned` bullets that summarize cannot overwrite
- Anon localStorage mirror (unlikely — conflicts with account benefit story)

## References

- Existing personalization: `playerName` in `lib/prompt.js`, `user_metadata.spoiler_major`
- Chat source for delta: `public.chats`, `chat_turns` (see `docs/plan/chat-persistence-refactor.md`)
- RAG infra (guide-only today): `lib/guide-rag.ts` — reuse embed stack only if v2 adds fact RAG
