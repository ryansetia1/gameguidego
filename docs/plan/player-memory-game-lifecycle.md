# Player memory & game lifecycle

**Status:** Planned — not implemented  
**Audience:** Future agents implementing delete-game memory UX and game identity matching  
**Last updated:** 2026-07-25  
**Related:** [user-memory.md](./user-memory.md), `app/page.tsx` `deleteGameRoom`, `app/profile/player-memory-section.tsx`, `lib/player-memory.js`, `lib/game-room.js`, `app/game-autocomplete.tsx`

## Purpose

Close the gap between **saved library** (chat rooms) and **Learn my style** per-game
memory (`player_game_memory`). Today:

- Deleting a game room removes chats + cover art only.
- Per-game memory rows can outlive the library entry (orphans in `/profile/memory`).
- There is no per-game **Forget** action in the memory editor.
- Memory keys are naive normalized strings (`normGameKey`); re-adding the same title
  with different punctuation does not reconnect saved memory.

This doc records a rollout agreed in design discussion (July 2026). Phases are ordered
by ROI and dependency; ship Phase 1 without waiting for the rest.

> **Revised scope (2026-07-25).** After a laziness pass the build order is:
> **Phase 1 (full, badge included) → Phase 3 (catalog id) → Phase 2 (light normalize, no backfill script).**
> **Phase 4 (fuzzy suggest link) is deferred, not scheduled** — it only helps free-text
> re-adds that also miss normalize, and Phase 3's catalog id already covers autocomplete
> picks. Build it only if real usage data shows manual-typo re-adds are common. The core
> vision — *park a game (delete chat, keep memory) and pick it back up* — is fully served
> by Phase 1 + Phase 3; nothing the user asked for is cut. See **Rollout order** for the
> trade-offs behind each call.

---

## Understanding summary

1. **What:** Lifecycle controls for per-game memory when users delete or re-add games,
   plus stronger game identity over time.
2. **Why:** Users with crowded libraries want to **park** games (delete chat, keep
   memory) and pick up progress later; they also need honest control when memory should
   be wiped.
3. **Who:** Signed-in users with **Learn my style** enabled (`player_memory_enabled`).
4. **Non-goals:** Auto-merge memory across platforms; silent fuzzy linking without user
   confirmation; changing global style memory on game delete.

---

## Current baseline

| Piece | Location | Notes |
|-------|----------|-------|
| Game room delete | `app/page.tsx` `deleteGameRoom` | Deletes all topics for `game` + `platform`; no memory touch |
| Memory key | `lib/player-memory.js` `normGameKey` | Lowercase + collapse whitespace only |
| Memory PK | `db/player-memory.sql` | `(user_id, game_key, platform)` |
| Room key | `lib/game-room.js` `gameRoomKey` | Same string normalization as memory |
| Memory load on solve | `lib/player-memory-server.ts` `loadMemoryForSolve` | Exact `normGameKey(game)` + platform |
| Memory editor | `/profile/memory` | Edit notes/progress per game; **Clear style memory** wipes all; no per-game delete |
| Autocomplete ID | `app/game-autocomplete.tsx`, `lib/games.js` | TheGamesDB `id` on pick — **not persisted** on `chats` or memory |
| Confirm dialog | `app/use-confirm-dialog.tsx` | Message + confirm/cancel only — **no checkbox yet** |

### User mental models (design input)

| Intent | Expected behaviour |
|--------|-------------------|
| **Park game** | Remove from library; keep progress/notes for when they add the game again |
| **Forget game** | Remove library entry and per-game memory |
| **Library cleanup** | Saved library less crowded; memory may list games not currently in library |
| **Re-add same game** | Memory should reconnect when identity matches (name or catalog ID) |

---

## Decision log

| Decision | Choice | Alternatives | Why |
|----------|--------|--------------|-----|
| Default on game delete | **Keep memory** | Always delete memory; always ask with no default | Matches "park library" use case |
| Opt-out on delete | Checkbox **"Also forget saved memory for this game"** (unchecked default) | Cascade delete with mention only | Explicit forget without blocking park flow |
| Global style on game delete | **Never delete** | Wipe style card too | Style is account-level, not per-game |
| Multi-platform memory | **Separate rows per platform** | Single row per game title | Progress/saves differ by platform |
| Cross-platform merge | **User-initiated only** (future) | Auto-merge same catalog ID | Avoid wrong progress on remasters / ports |
| Name variant matching | **Stronger normalize → catalog ID → suggest prompt** | Auto-merge on fuzzy name | False positives (FF7 vs Remake) are costly |
| Orphan visibility | **"Not in library" badge** on memory rows | Hide orphans; auto-prune | Transparent; user can forget manually |
| Anon users | **Out of scope** | localStorage memory | Memory feature is signed-in only today |

---

## Phase 1 — Delete game + memory controls (ship first)

**Goal:** User choice on delete; no silent orphans without visibility; manual per-game forget.

### 1a. Delete game dialog — optional forget memory

**Trigger:** `deleteGameRoom` confirm (sidebar, game card, library).

**UI:** Extend confirm flow with optional checkbox (requires `ConfirmDialog` / `askConfirm`
upgrade — see *Implementation notes*).

| Control | Default | Effect |
|---------|---------|--------|
| Checkbox: "Also forget saved memory for this game" | **Unchecked** | Unchecked → keep `player_game_memory` row |
| Body copy (when memory exists for this `game_key` + `platform`) | — | "Your saved progress and notes stay in Learn my style if you add this game again." |
| Body copy (when checkbox checked) | — | Append: "Saved progress and notes for this game will be removed." |

**Server/client actions when confirmed:**

1. Existing: delete chat rows, storage paths, update UI.
2. If checkbox checked **and** user signed in:
   - `DELETE FROM player_game_memory WHERE user_id = ? AND game_key = ? AND platform = ?`
   - Remove `userPins.games[gameMemoryPinKey(...)]` from `player_memory_state.style` (same pattern as `removeGameNote` in `player-memory-section.tsx`).
3. If unchecked: no memory writes.

**Pre-check:** Before showing dialog, optionally query `player_game_memory` for row existence
(signed-in only) to tailor copy. Fail-open: if query fails, show generic delete confirm
without memory mention.

**Anon:** No memory UI changes on delete (unchanged).

### 1b. "Forget this game" on `/profile/memory`

**Location:** Tab **Games** — each expandable game card (`player-memory-games-panel.tsx`).

**Control:** Text button **Forget this game** (danger style, below notes).

**Confirm:** `Forget saved progress and notes for "{Game} · {Platform}"? This cannot be undone.`

**Action:**

- Delete `player_game_memory` row.
- Clear pins for that `gameMemoryPinKey`.
- Remove card from list; toast: `Forgot memory for {title}.`

Does not delete chats or affect global style card.

### 1c. "Not in library" badge

**Location:** Same game cards in `/profile/memory` tab **Games**.

**Rule:** Row is **not in library** when no saved chat room matches
`gameRoomKey(displayNameFromKey, platform)` against current `chats` / `groupChatsByRoom` list.

**Display:** Small muted badge: `Not in library` next to game title (or under title on narrow screens).

**Notes:**

- Compare using `normGameKey` on chat `game` field vs `game_key` column (same normalization as today).
- Memory can be not-in-library **intentionally** after park-delete; badge is informational, not an error.
- Signed-in only (memory page already gated).

### Phase 1 files (expected touch)

| Area | Files |
|------|-------|
| Confirm + checkbox | `app/use-confirm-dialog.tsx`, `app/page.tsx` |
| Delete hook | `app/page.tsx` `deleteGameRoom` |
| Memory delete helper | `lib/player-memory-server.ts` (e.g. `deletePlayerGameMemory`) |
| Profile UI | `app/profile/player-memory-games-panel.tsx`, `app/profile/player-memory-section.tsx` |
| Library set for badge | Pass `libraryRoomKeys: Set<string>` into games panel from section |
| Styles | `app/globals.css` (badge + checkbox in confirm modal) |
| Tests | `npm run check` — add `normGameKey` / pin cleanup cases if helpers move |

### Phase 1 acceptance

- [ ] Delete game with checkbox **off** → chat gone, memory row remains, badge shows "Not in library".
- [ ] Delete game with checkbox **on** → chat + memory row gone.
- [ ] Re-add same `game` + `platform` after park-delete → solve turn still loads memory (`loadMemoryForSolve`).
- [ ] **Forget this game** removes row without deleting chats.
- [ ] Global style card untouched by per-game delete/forget.
- [ ] Copy follows brand voice (no em-dashes; short, second person).

---

## Phase 2 — Stronger `normGameKey` (quick win)

**Goal:** Collapse common display variants (`:` vs no colon, punctuation) without fuzzy guessing.

### Proposed algorithm

Extend `normGameKey` in **one shared place** (`lib/player-memory.js`; re-export or delegate from `lib/game-room.js` to avoid drift):

1. Unicode NFKD normalize (optional strip combining marks for accents).
2. Lowercase.
3. Remove punctuation: `: ; ' " - . , ! ? ( ) [ ]` (keep alphanumeric + spaces).
4. Collapse whitespace; trim.

**Examples:**

| Input A | Input B | Result |
|---------|---------|--------|
| `Assassin's Creed: Brotherhood` | `Assassin's Creed Brotherhood` | `assassins creed brotherhood` |
| `The Legend of Zelda` | `Legend of Zelda` | Still different (no leading "the" strip in v1) |

### Migration / backfill

**Problem:** Existing `player_game_memory.game_key` rows use old normalization.

**Options (pick one at implement time):**

| Option | Pros | Cons |
|--------|------|------|
| **A. Lazy on read** | No migration SQL | Two keys until user edits or refresh rewrites |
| **B. One-time backfill script** | Clean DB | Needs `scripts/backfill-game-keys.mjs` |
| **C. Dual lookup on solve** | No row rewrite | Slightly more read logic |

**Recommendation (revised):** **C — dual lookup only.** In `loadMemoryForSolve` try the
new key, fall back to the old key. Skip the backfill script (Option B): a park-deleted
row self-heals the moment the user re-adds and summarizes the game, so a migration is
maintenance for a problem that resolves on its own.

> **Trade-off (be honest):** dual lookup is **permanent debt**, not a free cut. Old rows
> keep the old normalization until a summarize rewrites them, and `loadMemoryForSolve`
> carries the fallback branch forever. **Do not delete the dual-lookup branch without
> first running a backfill** — removing it silently orphans pre-Phase-2 memory. Leave a
> `ponytail:` comment on the fallback naming that constraint. If you'd rather keep the DB
> clean than carry the branch, do Option B instead — that's a maintenance-taste call, not
> a correctness one.

### Non-goals (Phase 2)

- No stripping leading "The".
- No acronym expansion (`AC` → `Assassin's Creed`).
- No Levenshtein / fuzzy match (that's Phase 4).

### Phase 2 acceptance

- [ ] `npm run check` covers punctuation variants.
- [ ] `game-room.js` and memory use identical `normGameKey`.
- [ ] Re-add game with punctuation variant reconnects memory after backfill or dual lookup.

---

## Phase 3 — Persist `catalog_game_id` (stable identity)

**Goal:** When user picks from autocomplete, store TheGamesDB id so memory survives display-name changes.

### Schema

**New column** on `public.chats` (nullable):

```sql
alter table public.chats
  add column if not exists catalog_game_id integer;
-- ponytail: IGDB swap later may need text/uuid; integer matches TGDB today
```

**New column** on `public.player_game_memory` (nullable):

```sql
alter table public.player_game_memory
  add column if not exists catalog_game_id integer;
```

Add partial index optional: `(user_id, catalog_game_id, platform) where catalog_game_id is not null`.

SQL file: `db/catalog-game-id.sql` (+ mirror in `supabase/migrations/`).

### Write path

| Event | Action |
|-------|--------|
| Autocomplete pick | Set `catalog_game_id` in setup state; persist on first `chats` upsert |
| Manual typing | `catalog_game_id = null` |
| Memory summarize upsert | Copy `catalog_game_id` from chat context when known |
| Memory row create/update from profile | Leave null unless linked from chat |

### Read path (`loadMemoryForSolve`)

1. If `catalog_game_id` present on current chat → query memory by `(user_id, catalog_game_id, platform)`.
2. Else → `normGameKey(game)` + `platform` (Phase 2 key).
3. If hit on catalog id but `game_key` differs → optional row update to new display key (rename alias).

### Multi-platform note

Primary key remains `(user_id, game_key, platform)`. Catalog id is an **additional** lookup key, not a replacement PK (same game on PS3 vs PC stays two rows).

**Future (out of scope here):** UI hint "Also saved on PC" when same `catalog_game_id`, different `platform`.

### Provider swap (IGDB)

Document in `CLAUDE.md` when shipped: autocomplete provider change updates write path only;
memory lookup stays `catalog_game_id` + platform.

### Phase 3 acceptance

- [ ] Pick from autocomplete → id stored on chat row.
- [ ] Delete + park memory → re-add via autocomplete same id → memory loads despite title string change.
- [ ] Free-text game name → behaviour unchanged (string key only).
- [ ] Migration applied; client tolerates missing column (read `select("*")` pattern).

---

## Phase 4 — "Found similar saved memory" prompt

> **DEFERRED (2026-07-25) — do not build without data.** This is the most machinery
> (fuzzy scoring, per-pair dismiss persistence, trace logging) for the thinnest slice:
> a user who typed the game **manually** (no catalog id, so Phase 3 can't help) **and**
> whose variant is far enough from the Phase 2 normalize to miss (`Zelda BOTW` vs
> `Breath of the Wild`). If autocomplete adoption is high, this path is nearly empty.
> **Build only when `trace_events` or feedback shows manual-typo re-adds are a real
> frequency**, not on speculation. Kept here as a documented option, not a scheduled phase.

**Goal:** Safety net when user re-adds a game without matching catalog id or normalized name.

### Trigger

When user **starts a new room** (setup form submit or first persist) — signed-in + memory enabled:

1. Compute candidate rows from `player_game_memory` where:
   - **Strong:** same `catalog_game_id` + same `platform` (should not happen if Phase 3 works; handle legacy rows).
   - **Weak:** `normGameKey` fuzzy score ≥ threshold vs new game name, same `platform`.
2. Exclude rows already linked to an active library room (not "not in library").
3. If candidates remain, show **one-shot** confirm (not on every follow-up).

### UI (sketch)

Banner or confirm on setup:

> You have saved memory for **Assassin's Creed: Brotherhood · PS3**. Use it for this game?

| Action | Behaviour |
|--------|-----------|
| **Use saved memory** | Repoint: update `game_key` (and set `catalog_game_id` if pick had id); or merge notes into current key |
| **Start fresh** | Create new memory row on next summarize |
| **Not the same game** | Dismiss; store dismiss key in `localStorage` `gg:memory-link-dismiss` or `user_metadata` |

**Never auto-link on fuzzy match alone.**

### Fuzzy matching (conservative)

- Token overlap / normalized substring after Phase 2 normalize.
- Require same `platform` for auto-suggest.
- Cap one candidate shown (highest score).
- Log suggest shown in `trace_events` for tuning.

### Phase 4 acceptance

- [ ] Typo re-add suggests link when score high enough.
- [ ] FF7 vs FF7 Remake does **not** suggest (manual test cases in doc or check script).
- [ ] Dismiss persists per user per candidate pair.
- [ ] No prompt when library already has matching room.

---

## Implementation notes (Phase 1)

### Confirm dialog checkbox

`askConfirm` today returns `Promise<boolean>`. Phase 1 needs either:

- **Option A:** `askConfirmWithOptions({ message, checkbox?: { label, defaultChecked } })` → `{ confirmed, checkboxChecked }`, or
- **Option B:** dedicated `askDeleteGameConfirm({ game, platform, hasMemory })` in a small module.

**Prefer Option B (revised).** There is exactly one caller today; a generic checkbox
modal is abstraction for a second caller that doesn't exist yet. Ship the dedicated
helper. If a second checkbox-confirm flow appears later (e.g. "clear cover + delete from
storage?"), generalizing to Option A is a ~10-minute refactor at that point, not a
correctness risk — so defer it until the second caller is real.

### Shared helper (suggested)

```js
// lib/player-memory-game.js (new, small)
export async function deletePlayerGameMemory(supabase, userId, game, platform, { style, userPins })
export function memoryExistsForRoom(memoryRows, game, platform)
export function libraryRoomKeysFromChats(chats)
```

Centralize pin cleanup copied from `removeGameNote` today.

### Copy (English UI)

**Delete game (memory exists, checkbox unchecked):**

> Delete "{game}" and all {n} topics? This cannot be undone. Your saved progress and notes stay in Learn my style if you add this game again.

**Checkbox label:**

> Also forget saved memory for this game

---

## Rollout order

**Revised build order (2026-07-25):**

```
Phase 1 ──► Phase 3 ──► Phase 2 ──► (Phase 4 deferred)
(delete UX   (catalog id   (light norm    (build only on
 + badge)     = real fix)   + dual lookup)  usage data)
```

Phase 3 (catalog id) is the *real* identity fix and moves ahead of Phase 2, which
becomes a cheap companion for free-text entries only. Phase 1 stays first and complete
(badge included). Phase 4 is documented but unscheduled.

| Phase | Ships independently? | Depends on | Notes |
|-------|---------------------|------------|-------|
| 1 | Yes | — | Full incl. "Not in library" badge — badge is part of the park-delete story, not optional |
| 3 | Yes | — | Highest-value identity fix; do before Phase 2 |
| 2 | Yes | — | Light normalize + dual lookup; no backfill script |
| 4 | Yes | 2–3 reduce its need to ~zero | **Deferred**; build only on data |

### What each cut costs (so nothing gets dropped blindly)

| Cut | Risk vs the vision | Kept because |
|-----|--------------------|--------------|
| Generic confirm modal (Option A) → dedicated (Option B) | ~nil (later refactor only) | One caller today |
| Backfill script → dual lookup | Low, but dual lookup is permanent debt (don't delete branch without backfilling) | Park-deleted rows self-heal on re-add |
| Phase 4 not built now | Real but thin: free-text + far-variant re-adds miss the link | No data yet on manual-typo frequency; Phase 3 covers autocomplete picks |
| "Not in library" badge | **Not cut** — park-delete feels half-done without it | Core to the park-game story |

The park-game vision (delete chat, keep memory, pick it back up) is fully served by
**Phase 1 + Phase 3**. Phase 2 is a low-cost add; Phase 4 is a safety net that waits for
evidence it's needed.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Checkbox adds friction to delete | Only show memory copy when row exists |
| `normGameKey` false positive merge (Phase 2) | No auto-merge; only exact key match after normalize |
| Fuzzy suggest wrong game (Phase 4) | Same platform + high threshold + user confirm |
| `catalog_game_id` null for manual entry | String key fallback forever |
| TGDB id wrong for ambiguous search pick | User can Forget + Start fresh; Phase 4 not same game |

---

## Teardown

Grep: `forget saved memory`, `Not in library`, `catalog_game_id`, `deletePlayerGameMemory`,
`askConfirmWithOptions`, `memory-link-dismiss`, `player-memory-game-lifecycle`

Revert Phase 1 UI; leave DB columns from Phase 3 nullable unused if rolling back later phases only.

---

## Cross-links

- Parent feature: [user-memory.md](./user-memory.md)
- Game rooms: `lib/game-room.js`, `docs/plan/chat-persistence-refactor.md`
- Autocomplete / TGDB: `app/api/games/route.ts`, `lib/games.js`
- Answer quality (separate): [answer-satisfaction-signals.md](./answer-satisfaction-signals.md)
