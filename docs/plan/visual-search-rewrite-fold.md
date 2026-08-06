# Visual-search intent: fold into rewrite (kill the regex + the second LLM call)

**Status:** Shipped (2026-07-25). Detection folded into the rewrite, `visual_query`
LLM call removed, per-topic toggle replaced by a global profile toggle (default on).
Gates green (`npm run check`, `tsc`, `build`). Still to validate live: the 2-turn
follow-up trace (see "Multi-turn follow-ups" below).

## Problem

Visual reference-image lookup today decides "is this an appearance question?" with a
**two-language regex** (`isVisualLookupQuestion` in `lib/visual-search.js`), then runs
a **second Gemini call** (`resolveVisualSearchQuery`, `visual_query` kind) to build the
Serper image query.

Two costs:

1. **Regex is EN+ID only.** Any other language (JA/ES/PT/…) never triggers, even with
   the toggle ON. Indonesian slang/istilah also slips past keyword matching. This is a
   hard ceiling — already flagged `ponytail:` at `lib/visual-search.js:95-97`.
2. **A visual turn pays two rewrite-like LLM calls**: `resolveQuestion` (always) +
   `resolveVisualSearchQuery` (visual only). They overlap in job (translate + name the
   subject) and the second adds latency.

## Key insight

`resolveQuestion`'s `searchTopic` is **already translated to English** every turn.
Trace `6b99a23a`: `"bentuknya gimana"` → `"What is the appearance of the False Knight…"`.
So the rewrite is the natural, language-neutral place to detect visual intent — the
model already understands the question in any language at that point.

## Chosen design — Option 2: additive `VISUAL:` tag line

The web rewrite (`REWRITE_INSTRUCTION` path only, **not** `forRag`) keeps returning a
plain string. We extend the instruction:

- Line 1 = the web search query, exactly as today.
- **Only if** the question is about what something looks like, append a second line:
  `VISUAL: <subject>` naming just the subject (character/boss/item/enemy/location),
  **not** the game name.

Parsing = `split('\n')`, take line 1 as `searchTopic`, find a line starting with
`VISUAL:` for the subject. No JSON.

### Why not full JSON (Option 3)

`resolveQuestion` runs on the hottest path (every turn) and is currently bulletproof
(plain string, fallback to raw question). Making it emit JSON would let one parse
failure — the exact Gemini truncation/malformed-bracket class we fought 3× in memory
summarize — break the rewrite for **all** turns, not just visual ones. Not worth it.

### Why the tag is safe

The `VISUAL:` line is **additive**: its absence = "not a visual question" = safe
default. A garbled or missing tag degrades to "no image search" (same as a regex miss
today), never to a broken searchTopic. Line 1 is untouched on any tag hiccup. Blast
radius on non-visual turns is zero.

## Auto by default — remove the per-turn toggle

Once the rewrite decides visual intent, the per-topic **Reference images** toggle is
redundant (it was the symptom, not the feature). Two real problems it caused:

1. Users forget to switch it on, then reflexively ask "what does it look like?" and get
   no image.
2. It bloats the `+` menu — one more item to parse.

**Decision (2026-07-25):** go **auto by default**, gated only by intent, plus **one
global off-switch** in the profile menu (default **ON**) as a cost/clutter kill-switch.
Mirror the existing global spoiler pattern exactly (`spoiler_major`):

- New pref `gg:visual-auto` (localStorage) + `user_metadata.visual_auto` for signed-in
  sync. **Default ON** when unset. `coerceVisualAuto(value)` defaulting true.
- Toggle lives in `app/profile-menu.tsx` next to the spoiler toggle — **not** in the
  `+` menu.
- Remove the `+` menu item, its props, and all per-topic plumbing.

### Deletions (this is mostly a subtraction)

- `lib/visual-search-prefs.js`: replace the whole per-topic API
  (`loadTopicVisualSearchPrefs`, `saveTopicVisualSearchById`, `topicVisualSearchPayload`,
  `TOPIC_VISUAL_SEARCH_KEY`) with a single global `loadVisualAuto` / `saveVisualAuto` /
  `coerceVisualAuto` (copy `lib/spoiler-prefs.js`'s global half).
- `app/composer-extras.tsx`: drop `showVisualSearchToggle` / `visualSearchEnabled` /
  `onToggleVisualSearch` and the menu button (~20 lines).
- `app/page.tsx`: delete `topicVisualSearchEnabled` state, `pendingVisualSearchRef`,
  the create-time save effect, `updateTopicVisualSearch`, `toggleTopicVisualSearch`,
  and the per-open loads (~40 lines). Read the global pref once (like spoiler) and send
  it as `visualAuto` in the solve body.
- DB: `chats.visual_search` column goes dead. **Leave it** (nullable, ignored) —
  dropping it is optional cleanup, not worth a migration.

### Migration

Old per-topic values were opt-in **off**; the new baseline is **on**. Do **not** migrate
old values — just start reading the new global pref (default on). The old
`gg:topic-visual-search` key and `chats.visual_search` column become inert.

## Multi-turn follow-ups (MUST handle)

The headline case the design must not miss:

```
turn 1: "boss stage 1 itu gimana cara ngalahinnya?"   → answer, NO image (not visual)
turn 2: "rupanya gimana?"                              → MUST fetch an image of that boss
```

Turn 2 has **no explicit subject** — "rupanya" refers to the stage-1 boss from turn 1.
This already works structurally because `resolveQuestion` is **history-aware**: its whole
job is to rewrite a follow-up into a standalone English query using `history`. The
requirement is that the **same call** resolves the reference for BOTH outputs:

- Line 1 (searchTopic): `"stage 1 boss <name> appearance <game>"` — history fills the
  subject.
- `VISUAL:` line: the **resolved entity name** (`<boss name>` or, if turn 1 never named
  it, `"stage 1 boss"`), **never** the literal pronoun "rupanya".

Instruction requirements (in `REWRITE_INSTRUCTION`):

- "Resolve pronouns/references from the conversation history before naming the subject."
- "The `VISUAL:` subject is the concrete thing, never the question word (`it`, `that`,
  `rupanya`, `nya`)."

**Validation (cannot be unit-tested — it's LLM behavior):** run the exact 2-turn script
above against a live trace and confirm turn 2 emits a `VISUAL:` line with the boss name
and `visual_search_start` fires. Add the transcript to the PR. `scripts/check.mjs` only
covers the deterministic pieces (`parseRewriteOutput` splits the tag; dedupe guard).

## What ships

### 1. `lib/prompt.js`
- Extend `REWRITE_INSTRUCTION` with the `VISUAL:` rule (subject only, no game name;
  omit the line entirely when not an appearance question). Add one example each way.
- `VISUAL_SEARCH_QUERY_INSTRUCTION` + `buildVisualSearchQueryPrompt` become dead →
  delete (or keep only if we decide to retain the LLM path as a fallback; default:
  delete, we don't need it).

### 2. `lib/replicate.ts`
- `resolveQuestion` returns `{ searchTopic, visualSubject }` **or** keeps returning a
  string plus a sibling parse — decide at build time. Lazy pick: change the return to
  `{ searchTopic: string; visualSubject: string | null }` and update its ~2 callers
  (`app/api/solve/route.ts`; the `forRag` caller never sets a subject → always null).
  Parsing lives in one small helper `parseRewriteOutput(raw)` next to `resolveQuestion`.
- Delete `resolveVisualSearchQuery` (the `visual_query` LLM call) and its imports.

### 3. `lib/visual-search.js`
- Delete `isVisualLookupQuestion` (regex) and the EN/ID intent constants +
  `extractVisualSubject` (subject now comes from the rewrite). Keep
  `buildVisualSearchQuery`, `sanitizeVisualSearchQuery`, `pickBestSerperImage`.
- **Add dedupe guard** in `buildVisualSearchQuery`: before joining, drop game/platform
  tokens already present in `subject` (case-insensitive) so a subject that includes the
  game name (`"False Knight Hollow Knight"`) doesn't double it
  (`"… Hollow Knight Hollow Knight PC"`). One `filter` over tokens; covered by the
  self-check.

### 4. `app/api/solve/route.ts`
- Gate becomes: `visualAuto && !images.length && SERPER_API_KEY &&
  Boolean(visualSubject)`. `visualAuto` is the global pref (default on) sent in the
  body; the regex call is gone; the rewrite's `visualSubject` (non-null only when the
  model tagged it) is the real trigger.
- Serper query = `buildVisualSearchQuery(game, platform, visualSubject)` (heuristic
  join, no LLM). Same `pickBestSerperImage` scoring after.
- Trace events unchanged (`visual_search_start/complete`); drop the `visual_query`
  log kind usage.

### 5. Toggle relocation
- `lib/visual-search-prefs.js`: per-topic API → global `loadVisualAuto` /
  `saveVisualAuto` / `coerceVisualAuto` (default on). Mirror `lib/spoiler-prefs.js`.
- `app/profile-menu.tsx`: add the global toggle beside the spoiler toggle; write syncs
  to `user_metadata.visual_auto`.
- `app/composer-extras.tsx` + `app/page.tsx`: remove the per-topic toggle and plumbing
  (see Deletions above).

### 6. `scripts/check.mjs`
- Replace the `isVisualLookupQuestion` assertions with:
  - `parseRewriteOutput` splits `searchTopic` from a `VISUAL:` line, and returns
    `visualSubject: null` when there's no tag.
  - `buildVisualSearchQuery` dedupe: subject-with-game-name collapses to one game
    mention; subject-without is unchanged; banned words stripped.
  - `coerceVisualAuto` defaults to true on unset/garbage.

## Expected Serper input — unchanged

Today `visual_query` LLM emits `subject + game + platform`, sanitized, <12 words
(trace: `False Knight Hollow Knight PC`). Option 2's `buildVisualSearchQuery` produces
the same `subject + game + platform`, sanitized — literally identical in the normal
case. The subject wording is equal quality (same model, same context, one call
earlier). Differences: game+platform appended deterministically (LLM already always
included them), plus the new dedupe guard (strictly safer).

## Cost delta

- Visual turn: **2 LLM calls → 1** (rewrite does both jobs). `visual_query` gone.
- Non-visual turn: unchanged (still just the rewrite).
- Detection: regex (EN+ID) → model intent (**any language** + slang/istilah).
- **Serper volume goes up** (feature flips from opt-in-off to on-by-default). Still
  bounded: only appearance-questions, one call, fail-open, gated by `visualSubject`.
  The global profile toggle is the kill-switch if a user wants zero image calls.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Rewrite spends attention on the visual decision, perturbing searchTopic on normal turns | Instruction: "default = query only; add `VISUAL:` only when clearly about appearance" |
| Model forgets the tag on a real visual turn | Degrades to no image search (same as a regex miss today); acceptable, and rarer than regex gaps |
| Follow-up with no explicit subject ("rupanya gimana?") | `resolveQuestion` is history-aware; instruction resolves references before naming the `VISUAL:` subject — see the must-handle section. Validate on a live 2-turn trace |
| Auto-on shows an irrelevant image on a false-positive tag | `pickBestSerperImage` returns null below the score threshold — a weak/wrong subject usually yields no image |
| Subject includes the game name → duplicated Serper query | Dedupe guard in `buildVisualSearchQuery` |
| `resolveQuestion` return-type change touches the hot path | Small, typed; `forRag` caller passes null; string→object is a compile-time-checked refactor |
| No opt-out for data-savers | Global profile toggle (default on) |

## Follow-up: load probe (2026-08-06, trace `c36cf856`)

A Link's Awakening "Yarna Desert itu kaya gimana?" turn picked an image and shipped it,
but nothing showed in the chat. The pick was a `zeldadungeon.net` wiki thumb, which sits
behind Cloudflare's "Just a moment" challenge and answers 403 HTML to every fetch
(no-referer, browser UA, and with a matching Referer). It is not in
`ALLOWED_IMAGE_HOST_SUFFIXES` either, so the browser hotlinked it, got the 403, and the
`onError` handler in `app/chat/message-list.tsx` hid the whole `<figure>`. Net effect: a
successful `visual_search_complete` trace and an empty answer.

Blocklisting that one host was not enough: the next-ranked candidate for the same query
was a TikTok CDN URL, also 403.

Fix: `pickBestSerperImage` was split into `rankSerperImages` (pure ranking, same scoring
and score>=4 gate) plus `pickLoadableIllustration`, which load-probes the top 3 in
parallel (`probeImageUrl`: GET, cancel the body once headers arrive, 6s timeout) and
returns the first that answers with an `image/*` content type. Probing overlaps answer
generation, so it costs one timeout at worst (measured ~300ms live). Higher-ranked
candidates that failed are logged as `unloadableUrls` on `visual_search_complete`, since
a hidden broken `<img>` otherwise leaves no trace at all.

Known ceiling (ponytail): the probe runs from the server, so a host that serves our
datacenter but blocks the browser (or the reverse) can still mis-rank. `referrerPolicy="no-referrer"`
on the `<img>` keeps the two requests close. Upgrade path if that bites: route every
illustration through `/api/visual-image` (needs an HMAC-signed URL to avoid an open proxy).

## Teardown

Grep: `VISUAL:`, `visualSubject`, `parseRewriteOutput`, `buildVisualSearchQuery`,
`visualAuto`, `visual_auto`, `visual_search_rewrite_fold`. Revert = restore
`isVisualLookupQuestion` + `resolveVisualSearchQuery` + the per-topic toggle, and change
`resolveQuestion` back to a string return.

## Cross-links

- Gating today: `app/api/solve/route.ts` (`wantsVisualIllustration`),
  `lib/visual-search.js`, `lib/replicate.ts#resolveVisualSearchQuery`
- Reference-images toggle: `lib/visual-search-prefs.js`, `app/composer-extras.tsx`
- Rewrite: `lib/prompt.js#REWRITE_INSTRUCTION`, `lib/replicate.ts#resolveQuestion`
