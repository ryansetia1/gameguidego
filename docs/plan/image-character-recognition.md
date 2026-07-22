# Image character recognition (prompt-only)

**Status:** Experimental — **patut dicoba, riskan** (July 2026)  
**Shipped:** Prompt text in `lib/prompt.js` (+ `imageResolvedSubject` wire in `app/api/solve/route.ts` → `summarize`)  
**Runtime:** No new API, flag, or DB. Gemini already receives message images via Replicate `images`.

## What it does

### A. Character naming rules (prompt-only)

When the player attaches screenshot(s), the model is instructed to:

- Name recognizable characters from game knowledge (not only literal appearance).
- Hedge when uncertain: `(maybe Sonic)` / `(mungkin Sonic)`.
- Name multiple characters when several appear.
- Never assert a wrong name with false certainty.

| Call site | Constant / function |
|-----------|---------------------|
| Answer generation | `buildPrompt` → `IMAGE_CHARACTER_RULES` |
| Web-search rewrite | `REWRITE_INSTRUCTION`, `buildRewritePrompt` → `IMAGE_REWRITE_CHARACTER_RULES` |
| Preferred-guide RAG rewrite | `REWRITE_RAG_INSTRUCTION` |

### B. Rewrite → summarize soft anchor (July 2026)

When the current turn has image attachment(s), `POST /api/solve` passes the rewrite
output (`searchTopic`) into `summarize` as `imageResolvedSubject`. `buildPrompt`
injects a capped excerpt (~280 chars) before the player's question:

> Visual context for this turn (resolved from the attached image): …  
> Use this to interpret "this"/"ini"/"here"/"itu". …  
> Do not let unrelated guide snippets override what the image shows.

**Motivation:** trace `1aed1dfa-70f7-4f96-8be9-ec6eb2492a86` — rewrite correctly
identified Brothers (Minotaur/Sacred) but summarize mis-read the image as Tonberry
and followed an irrelevant preferred-guide RAG chunk.

**Code path:** `resolveQuestion` → `searchTopic` → `summarize({ imageResolvedSubject: searchTopic })` → `buildImageSubjectAnchor()` in `lib/prompt.js`. Gated: only when `images.length > 0` on **this** turn.

## Why it is risky

| Risk | Symptom in production |
|------|------------------------|
| **Wrong ID with confidence** | Guide answers for the wrong boss/NPC despite hedging rules |
| **Cross-game confusion** | Similar-looking character from another franchise named incorrectly |
| **Spoiler leakage** | Naming an unmasked character the player has not met yet |
| **Bad search/RAG queries** | Rewrite injects a wrong name → worse Tavily hits or guide retrieval |
| **Over-naming** | Generic mobs or custom skins forced into a famous name |
| **Mod / ROM hack art** | Vanilla-game knowledge mislabels modded sprites |
| **Rewrite wrong → summarize locked in** (anchor B) | Summarize trusts rewrite vision; loses independent second opinion |
| **Over-anchor to image** (anchor B) | Player asks something else but answer stays on rewrite subject |
| **Token bloat** (anchor B) | Long RAG rewrites add ~280 chars to every image turn summarize prompt |

Prompt-only guardrails help but **cannot guarantee** vision accuracy. Treat as tuning, not a feature contract.

## What to watch (before reverting)

1. **`public.llm_calls`** (or `llm-log.json` in dev): `rewrite` + `summarize` rows on turns **with images** — compare query text and answer quality before/after.
2. **Admin trace** (`/admin`, `X-Trace-Id`): image turns where search or RAG returns irrelevant sources after a bad rewrite.
3. **User reports**: “it called the wrong character”, “spoilers”, “answer is for a different boss”.
4. **Anchor-specific:** summarize `prompt` contains `Visual context for this turn` — check entity matches rewrite and image; wrong lock-in means revert B first.
5. **A/B manually**: same screenshot + question with rules on vs reverted locally.

If failures are rare and hedged (`maybe X`), consider **softening** the prompt before a full revert (see below).

## Revert (full)

No env var — revert is a **code change**. Deploy after revert like any other fix.

### Option A — Git (preferred if this shipped as its own commit)

```bash
git log --oneline -- lib/prompt.js lib/replicate.ts app/api/solve/route.ts scripts/check.mjs

git revert <commit-sha>   # repeat for anchor commit if separate

npm run check
```

### Option B — Manual: character naming only (section A)

1. **Delete** `IMAGE_CHARACTER_RULES` and `IMAGE_REWRITE_CHARACTER_RULES` from `lib/prompt.js`.
2. Restore image blocks / `REWRITE_*_INSTRUCTION` per original text (see git history or section below in old commits).
3. Remove image-character asserts in `scripts/check.mjs`.

### Option C — Manual: rewrite→summarize anchor only (section B)

Revert anchor **without** removing character naming rules:

1. **`app/api/solve/route.ts`:** remove `imageResolvedSubject: images.length ? searchTopic : undefined` from `summarize({...})`.
2. **`lib/replicate.ts`:** remove `imageResolvedSubject` from `SummarizeInput` and `buildPrompt` call.
3. **`lib/prompt.js`:** delete `IMAGE_RESOLVED_SUBJECT_CAP`, `trimImageResolvedSubject`, `buildImageSubjectAnchor`, `imageResolvedSubject` param, and `imageSubjectAnchor` in `buildPrompt`.
4. **`scripts/check.mjs`:** remove `trimImageResolvedSubject` import and anchored-prompt asserts.
5. `npm run check`, deploy.

### Option D — Manual: revert everything (A + C)

Combine B and C steps, or restore `buildPrompt` image block to:

```js
  const imageBlock =
    imageCount > 0
      ? `The player attached ${imageCount} image(s) with this question (e.g. a screenshot or photo of where they are stuck). Use them as visual context — identify the exact screen, location, item, enemy, or menu shown, and read any dialog or text present — and prioritise what they depict over guesses.\n\n`
      : "";
```

(no `imageSubjectAnchor`, no character rules in rewrite instructions)

## Partial rollback (softer, not full revert)

**Character naming (A):**

- Remove the Sonic example (reduces over-eager franchise matching).
- Add: “Only name characters when the stated **Game** field matches the franchise.”
- Change confident naming to **always** require hedging.

**Anchor (B):**

- Shorten `IMAGE_RESOLVED_SUBJECT_CAP` (280 → 120) to reduce noise.
- Soften wording: remove “Do not let unrelated guide snippets override…” if it fights preferred-guide too hard.
- Inject only the **first sentence** of `searchTopic` instead of capped paragraph (needs small code change).

Keep rewrite rules in sync if you change naming policy (search quality depends on them).

## Related code

- Image upload/compress: `lib/image.js`, `app/page.tsx`
- Images + anchor wire: `lib/replicate.ts` (`resolveQuestion`, `summarize`), `app/api/solve/route.ts`
- Client attach UX: `app/composer-extras.tsx`, `app/chat/composer-shell.tsx`

Reverting this doc’s changes does **not** disable image attachments.
