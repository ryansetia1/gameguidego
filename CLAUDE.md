# GameGuide Go

## Purpose

Mobile-first, installable (PWA) Next.js prototype that answers a player's game
question. The model (Gemini 2.5 Flash on Replicate) answers from its own
knowledge; tiered web search provides supporting evidence. Supports
TheGamesDB-backed game-name autocomplete (with box art; IGDB is the eventual
upgrade), a fuzzy/acronym-aware platform selector, multi-turn
follow-up chat, an optional preferred-guide source, and optional Supabase
accounts that save per-game chats. The UI is English; the model still answers in
the player's input language. No login wall: signed-out users keep full access
and simply cannot save.

## Architecture

- `app/page.tsx`: English client chat UI (game field, platform, optional
 preferred-guide link, global major-spoiler toggle (profile menu + `user_metadata.spoiler_major`), message feed,
 docked composer) and `/api/solve` consumer.
  Keeps `messages` state and sends the last 10 messages (5 turns) as `history`
  plus `preferredUrl` and `spoilerPrefs` (`major`, default off). Also owns Supabase auth state, the "Your games" menu
  (list/resume/new/delete), per-turn chat persistence (auto-creates a new saved
  chat when the game name changes mid-session), edit/retry on message bubbles,
  structured highlight sections on assistant replies, a game metadata card with
  box art (replaces the input fields once a chat starts; edit reopens the fields),
  cover art (signed-in only, to keep the anon flow simple and Storage-free):
  TheGamesDB box art plus optional device upload whose Storage write is DEFERRED to
  the first save (so abandoned drafts cost nothing), with a letter-tile placeholder
  fallback; autocomplete also auto-fills the platform selector via
  `tgdbPlatformToLabel`; a sticky mini-header (cover + game/platform + back-to-top),
  a collapsible left sidebar (burger toggle) that lists saved games (cover + game +
  platform·year) with a per-row kebab -> Edit/Delete menu and a Library button that
  opens a 2-column cover-art grid,   per-message image attachments (signed-in only: compressed client-side, one
  paperclip menu beside Send for photo library or camera, uploaded to the `covers` bucket at send time, sent
  to Gemini via Replicate's `images` field`; edit/retry drops truncated turns'
  Storage images), profile avatar menu (theme, spoilers, sign out) and `/profile`
  page for `user_metadata.display_name` (LLM uses it in prompts), theme via
  `gg:theme` / `user_metadata.theme`,
  light-markdown rendering of answers (`lib/markdown.js`: bold/lists/headings),
  a dismissable examples strip
  (remembered in `localStorage`), and auto-scroll (smooth on new turns, instant
  jump to the last user message when opening a saved game). Refresh restores the open thread via `?chat=<id>`
  (signed-in saved chats) or a `sessionStorage` draft (`lib/chat-session.js`;
  anon / not-yet-saved). `runTurn`/`persistChat` centralise ask +
  save; `conversationGame` tracks which game the visible thread belongs to.
  **Temporary chat** (`temporary` flag): entered from the composer "+" menu, or via
  a quick-access incognito button on the saved game card (`.game-card-incognito`)
  and the sticky mini-header (`.sticky-incognito`), both shown when
  `activeChatId && !temporary`. While on, the docked composer's border
  goes **dashed** (`.composer.temporary`) and a dim, borderless incognito glyph sits
  left of "+" (`.composer-temp-flag`, tap to turn off) — an always-visible signal,
  unlike a header badge that scrolls away.
  When on, `persistChat` returns early and the URL/`sessionStorage` sync effect
  writes nothing, so the thread is memory-only and a refresh/close wipes it (follow-ups
  still work from `messages` state). It is a non-destructive detour: turning it ON
  snapshots the open thread (`preTemporaryRef`) and starts a fresh thread (keeping
  game/platform/cover); turning it OFF restores that snapshot, so cancelling before
  chatting drops you back in the chat you left. Only discarding a temporary thread
  that already has content confirms ("Discard"); an empty one turns off silently.
  Uploaded message images are deleted from Storage each turn so nothing orphans.
  `newGame`/`openChat` reset the flag off.
  While a turn runs the Send button becomes a **Stop** button that aborts the
  `/api/solve` fetch (`abortRef`); the abort propagates via `request.signal` to
  cancel the Replicate prediction + Tavily search server-side. A promise-based
  confirm dialog (`askConfirm(message, confirmLabel?, danger=true)` →
  `confirmState`) guards every destructive action (delete chat from the
  sidebar/game-card/library kebabs, clear cover, and edit/retry when it would drop
  attached images). Pass `danger:false` for a positive CTA (brand-accent button
  instead of red), e.g. the "Use your Steam account" offer. A themed `snackbar` (`toast`)
  confirms a successful Steam link. The game-card and saved-library cards use the
  sidebar kebab pattern (`menuOpenId`/`toggleRowMenu`) for Edit/Delete; the
  sticky-header back arrow calls `goHome` (pops the pushed chat entry). Mobile
  **edge-swipe**: left→sidebar, right→last-opened library (`lastLibrary`; Steam
  when connected, else saved), signed-in only, disabled while an overlay/edit is
  active.
- `app/auth-panel.tsx`: themed sign-in/sign-up modal (email+password, Google
  OAuth via `getSupabase().auth`, and **Continue with Steam** →
  `/api/steam/login?intent=signin`). Surfaces the "check your email" state when the
  project has email confirmation enabled.
- `lib/supabase.ts`: `getSupabase()` singleton browser client from the
  `NEXT_PUBLIC_SUPABASE_*` vars; returns `null` when unset so the app degrades to
  anonymous-only. Exports the `Chat` row type.
- `lib/local-games.js`: anon "recent games" list in `localStorage`
  (`gg:local-games`, `Chat`-shaped, cap 20) so signed-out users also get the
  home quick-access carousel, sidebar, and library. `loadChats`/`persistChat`/
  `saveGameMeta`/`deleteChat` in `page.tsx` branch on `userRef` (Supabase when
  signed-in, this when anon). Anon has no Storage, so these rows are text +
  metadata only (cover is a CDN URL or ""). **Home layout:** empty account →
  marketing hero + setup form (+ examples); has saved games → compact hero +
  **Jump back in** carousel (`.quick-home`, native scroll-snap, uniform cards,
  up to 4 + a "+N more" tile that opens the saved library) + **"+ New game"** /
  **Saved library** / **Steam library** (when connected) buttons. "+ New game"
  collapses the hero (`.hero-shell--exit`) and reveals the setup form below the
  carousel with a push-up entrance (`.setup--from-quick`). Sidebar + library are
  ungated for anon (Steam/profile controls stay `user`-only).
- `app/platform-select.tsx`: custom themed, searchable, keyboard-accessible
  platform combobox. Delegates filtering to `lib/platforms.js`.
- `lib/platforms.js`: owns the `PLATFORMS` list and `matchPlatforms(query)`, a
  normalized-substring + acronym/alias matcher (n64, nds, psx, ps1, ps2, gba,
  xsx, ...), plus `tgdbPlatformToLabel(name)` which maps a TheGamesDB platform
  name to one of our labels (numbered consoles before the bare family; "" when
  unsure, so autocomplete never auto-fills the wrong platform). `npm run check`.
- `app/game-autocomplete.tsx`: debounced game-name autocomplete for the game
  field; queries `/api/games`, reuses the `.combo` styling, shows a box-art thumb
  per row, and groups results by platform label (`groupByPlatform` via
  `tgdbPlatformToLabel`) so a multi-console game lists one row per console under a
  header — headers only when >1 group. `prepareAutocompleteGames` (in
  `lib/games.js`) collapses identical TGDB rows under the same name · platform ·
  year and shows a release-date hint when real variants remain. Allows free text and hides itself when the
  DB is unavailable (`available: false`). `onPick` surfaces the chosen
  `{ name, year, cover, platform }` to the page (manual typing clears the stale
  cover); `showCover` is off for signed-out users.
- `app/guide-link-field.tsx`: preferred-guide twin tabs — **Paste link** (URL
  input) or **Search web** (queries `/api/guide-search` with game/platform +
  optional keywords; **Use** fills `preferredUrl` and switches back to paste).
  Auto-runs a search when the tab opens if a game name is set.
- `app/api/guide-search/route.ts`: browse endpoint for the picker. Calls
  `discoverGuideLinks` (tiered Tavily/Serper, no answer-time confidence gate).
  Returns `{ results: [{ title, url, snippet }], available }`; `available: false`
  when neither `TAVILY_API_KEY` nor `SERPER_API_KEY` is set.
- `lib/steam.js`: Steam OpenID login URL + verification, owned-games fetch
  (`IPlayerService/GetOwnedGames`), Steam CDN library cover URLs,
  `fetchSteamReleaseYear` (keyless Store `appdetails` — no `filters=basic`, which
  omits `release_date`; owned-games has no release date. Keyless on purpose so the
  year works even when `STEAM_API_KEY` is unset; IP rate-limited ~200/5min), and
  `steamIdFromMetadata` (reads the linked `steam_id` from Supabase `user_metadata`).
  Steam is **both a sign-in method and a link action**. Steam OpenID returns
  ONLY a numeric SteamID (no email), so a Steam login can never merge-by-email
  with a Google/email account — Steam-login accounts live in a reserved email
  namespace (`steam_<id>@steam.gameguidego.local`, see `lib/steam-account.js`).
  **Sign in with Steam** ("Continue with Steam" in the logged-out auth modal):
  after OpenID verifies the SteamID, `POST /api/steam/session` (service-role)
  resolves **one SteamID → one home account**: if a Google/email account already
  linked this Steam (`findLinkedAccount` scans users for `steam_id` with
  `login_via !== "steam"`), it signs into THAT account via `admin.generateLink`
  (magiclink) + server-side `verifyOtp`; otherwise it admin-creates/reuses a
  synthetic account keyed by the SteamID (deterministic HMAC password,
  `email_confirm:true`) and `signInWithPassword`. Either way it returns the
  session tokens for the client to adopt (`loginWithSteam` → `setSession` +
  `refreshSession`). The Steam persona `display_name`/`avatar_steam` come from
  `fetchSteamProfile` and `avatar_steam` is refreshed on every login. The library
  then loads from the account's `steam_id`. **Link** ("Connect Steam" in the
  sidebar, signed-in only) attaches Steam to an existing Google/email account,
  unchanged. `/api/steam/link` refuses (409 `steam_is_login_account`) to attach a
  SteamID that already backs a *synthetic* Steam-login account (no auto-merge; the
  user picks one entry point). On that 409 the client doesn't dead-end:
  `linkSteamToAccount` returns `is_login_account`, and the `?steam=linked` handler
  offers a "Use your Steam account" confirm that runs `loginWithSteam` to switch
  into the existing Steam account. Intent is round-tripped through
  the OpenID `return_to` (`i=signin|link`), so the callback redirects
  `?steam=signin` vs `?steam=linked` with no extra cookie. Requires
  `SUPABASE_SERVICE_ROLE_KEY` + `STEAM_API_KEY`; without the service key the
  bridge 501s and Steam degrades to link-only. `lib/steam-session.js` signs
  a device-scoped `gg_steam` HMAC cookie (30-day, keyed by `AUTH_SECRET` or
  `STEAM_API_KEY`) holding the verified numeric SteamID — Steam OpenID never
  returns an email, so accounts never merge by email.
  Flow: `app/api/steam/login` -> Steam OpenID -> `callback` verifies and sets the
  `gg_steam` cookie, then redirects `/?steam=linked`. The client links **only**
  on that explicit return (`linkSteamToAccount` writes `steam_id` via
  `POST /api/steam/link` with bearer + `refresh_token` so the route can
  `setSession` before `updateUser` — see `docs/troubleshooting.md` if link
  fails with `Auth session missing!`); the sign-in effect merely *refreshes* status and never
  auto-links, so a leftover device cookie can't silently attach to the next user.
  `signOut` clears `gg_steam` (`DELETE /api/steam/pending`). `GET /api/steam/me`
  and `GET /api/steam/library` (Bearer token) trust **only** the account's linked
  Steam when authenticated — the cookie is used solely in the token-less transient
  right after the OpenID return — so a shared browser can't leak one user's
  library to another. `app/steam-library.tsx` grid UI (with search filter, a
  **sort control** — icon button beside the search bar; options Recently played /
  Most played / Name / Release year, each toggling asc/desc (↑/↓ on the active
  option, menu reveal animated), default Recently played (desc) since Steam
  exposes no "date added"; persisted as `"<key>:<dir>"` in
  `user_metadata.steam_sort` + `localStorage` `gg:steam-sort` so it syncs across
  devices — and square in-theme loading
  skeletons); each card shows **platform · release year** (not playtime).
  The active **game card** (cover + title + platform · year) also shows optional
  HowLongToBeat playtime (`27h main story`) for any game title via
  `app/hltb-row.tsx` + `GET /api/hltb?title=` (optional `appId` when the cover
  is a Steam CDN URL). The sticky header shows the same main-story figure inline
  after platform · year (flex-wrap when space is tight). Server read-through cache in
  `public.hltb_cache` keyed by normalized title (30d TTL — see `db/hltb-cache.sql`).
  Existing pre-year Steam chats are backfilled once per mount by an effect in
  `page.tsx` that reads the appId from the chat's Steam cover URL
  (`steamAppIdFromCoverUrl`) and fills the empty `release_year`. The `/api/steam/library` route enriches owned-games with release
  years via `fetchSteamReleaseYears` (batch `IStoreBrowseService/GetItems`, one
  call per 50-id chunk) so the year is on the `SteamGame` when picked — no per-game
  fetch. Picking a game opens/resumes a PC chat with Steam cover art (year set
  immediately from the shelf; `/api/steam/release-year` is only a fallback for
  games GetItems omits). It caches the fetched list in `localStorage` (`gg:steam-library`,
  keyed per account via the `cacheKey` prop, 6h TTL) and renders it instantly on
  reopen while revalidating in the background (stale-while-revalidate) — no more
  full reload every open. Requires `STEAM_API_KEY`; user's Steam **Game details**
  must be Public.
- `lib/hltb.js` + `lib/hltb-cache.js` + `app/api/hltb/route.ts` + `app/hltb-row.tsx`:
  HowLongToBeat playtime on the game card (any platform). HLTB has no public API;
  the server fetches a per-visit token from HLTB's rotating internal search
  endpoint (`SEARCH_SEG` in `lib/hltb-cache.js`), searches by normalized title
  tokens, and matches via `pickBestMatch` (optional Steam appId → exact name →
  fuzzy). Results are cached in `public.hltb_cache` (`cache_key` = normalized
  title, nullable `data` jsonb, 30d TTL). No login required. Fail-open when
  Supabase is unset (direct upstream search).
- `app/api/games/route.ts`: TheGamesDB proxy. Runs
  `Games/ByGameName?include=boxart,platform` with `THEGAMESDB_API_KEY` and returns
  `{ games, available }` (each game has `cover` + raw `platform` name). Missing key
  or any failure => `available: false` so the field degrades to free text.
  `lib/games.js#mapGames` shapes the payload. Provider swap to IGDB later is this
  file + `mapGames` only.
- `app/api/solve/route.ts`: validates/sanitizes `{ game, platform, question,
  history, preferredUrl, spoilerPrefs, playerName }` at the trust boundary (history capped to 10, content
  truncated, `preferredUrl` must be http/https, `spoilerPrefs` coerced to booleans,
  `playerName` from `display_name`, max 32 chars). Always calls `resolveQuestion`
  to rewrite the query into standalone English before searching. Wraps the search
  in a cache (`lib/search-cache.ts`) keyed by `searchQuery + preferredUrl`.
  Search is best-effort (skipped if no `TAVILY_API_KEY`, failures swallowed); the
  model still answers. Returns `{ answer, highlights, sources }`. Only
  `REPLICATE_API_TOKEN` is mandatory.
- `lib/tavily.ts`: `searchGuides(query, preferredUrl?)` orchestrates Tavily then a
  Serper.dev fallback; `discoverGuideLinks(game, platform, query?)` powers the
  guide picker (same providers, returns up to 8 hits without `selectSources`).
  Query text is built by `lib/guide-search.js#buildGuideDiscoveryQuery`. `searchTavily`
  throws when every Tavily call fails so
  `searchGuides` can fall back to `searchSerper` (snippet-only: a preferred host
  becomes a `site:` filter, else one general query, trimmed to top 3). With no
  `preferredUrl` the Tavily path
  it runs the normal tiered search (GameFAQs -> trusted walkthrough providers ->
  forums -> general).  With one it cascades: (1) for a deep chapter URL, extract that page in full
 (via `focusSection`), else (2) site-search the host for the right section page,
 else (3) site-search snippets, else (4) for hub/root URLs extract the pasted
 URL, else (5) fall back to the tiers. Steps 1-4 return sources solely from the
 preferred site and SKIP the confidence gate (the user's site choice is trusted,
 so a low-scoring but correct fan-site page still wins over the pasted hub URL).
 The extracted page is trimmed to the query-matching window via `focusSection`, not
  its opening. All paths use `search_depth: "advanced"`, exclude video/social
  domains, dedupe by URL+title, clean via `cleanSnippet`, and the tiered path
  gates/trims via `selectSources`.
- `lib/search-cache.ts`: best-effort Supabase-backed cache of `searchGuides`
  output (`getCachedSearch`/`setCachedSearch`, 7-day TTL). Uses a server client
  built from the `NEXT_PUBLIC_SUPABASE_*` vars (no session); no-ops when unset or
  on any error so answers never depend on it.
- `lib/rank.js`: `selectSources(results)` applies a confidence gate (returns
  `[]` when even the best score is below `CONFIDENCE_MIN`, so the model answers
  from knowledge alone), keeps results within `SCORE_WINDOW` of the top score,
  and caps at 3. Covered by `npm run check`.
- `lib/clean.js`: `cleanSnippet(text)` strips markdown link soup, bare URLs,
  GameFAQs CTAs, and Q&A vote/user lines. `focusSection(text, query, cap)` trims
  a long extracted page to the `cap`-sized window with the most query-term hits,
  so a huge single-page guide is cut to the relevant section. Both covered by
  `npm run check`.
- `lib/replicate.ts`: Replicate adapter. `summarize(input)` sends
  `system_instruction` + `prompt` separately with Gemini fields
  (`max_output_tokens`, `thinking_budget: 0`) and parses the JSON
  `{ answer, highlights }` via `lib/highlights.js#parseSummary`. `resolveQuestion({
  question, history })` does a small, low-token call to rewrite any question into
  a standalone English search query, falling back to the raw question on any
  failure. Exports the `Turn`, `Highlight`, and `SummaryResult` types.
- `lib/profile.js`: `display_name` / avatar helpers for the profile menu and page.
  `avatarUrlFromUser` is pref-aware: it honours `user_metadata.avatar_pref`
  (`google`/`steam`/`upload`) when that source exists, else falls back
  upload > google > steam (so unifying a Steam login into a Google account keeps
  the Google photo). `avatarSourcesFromUser` exposes the per-source URLs
  (`picture`/`avatar_url`, `avatar_steam`, `avatar_upload`) for the `/profile`
  photo picker. The picker uploads to the `covers` bucket (`<uid>/avatar-*.jpg`)
  and writes `avatar_upload` + `avatar_pref`.
- `lib/image.js`: `compressImage(file, maxDim, quality)` — client-side canvas
  downscale + JPEG re-encode shared by covers, message images, and avatar upload.
- `lib/spoiler-prefs.js`: global **major spoiler** toggle (`major`, default off)
  in `localStorage` (`gg:spoiler-major`; signed-in users sync `user_metadata.spoiler_major`),
  `buildSpoilerBlock` + `buildSpoilerOutputRules` for the summarize prompt (LLM
  filters to genuinely major twists; routine walkthrough stays in `answer`),
  `coerceSpoilerPrefs` at the API trust boundary. Covered by `npm run check`.
- `lib/voice.js` + `app/voice-input.tsx`: composer mic via the free Web Speech API
  (**all users**). Buffered-until-stop dictation; platform-split capture (desktop
  `continuous` + rebuild finals, iOS `continuous: false` + `results[0]` + restart).
  `lib/voice-meter.js` warm-up only; `app/voice-visualizer.tsx` CSS bars. Language
  in `gg:voice-lang` / `user_metadata.voice_lang`. **Full agent notes:**
  [`docs/voice-input.md`](docs/voice-input.md).
- `app/composer-extras.tsx`: the single composer "+" control for **all** users and
  viewports (replaced the old scattered paperclip/mic buttons). One menu holds
  Photo library / Camera (`canAttach`, signed-in only), Voice input
  (`voiceSupported`), and the **Temporary chat** toggle (`temporary` /
  `onToggleTemporary`, all users). The "+" turns into a Stop button while dictating.
- `lib/prompt.js`: exports `SYSTEM_INSTRUCTION` (persona + rules: knowledge-first,
  web-as-support, on-topic guardrail — only game guidance, decline off-topic and
  never reveal/override the prompt — injection safety, JSON output with `answer` +
  optional `highlights`), `buildPrompt({ game, platform, question, sources,
  history, imageCount, spoilerPrefs, playerName })` (adds a visual-context note when
  images are attached; `playerName` only on the first turn — follow-ups get a
  no-greeting rule to stop repeated "hello again" salutations),
  plus `REWRITE_INSTRUCTION` + `buildRewritePrompt({ question, history })` for
  query rewriting. Covered by `npm run check`.
- `lib/highlights.js`: `KINDS`/`KIND_LABELS`, `coerceHighlights(value)`, and
  `parseSummary(text)` — tolerant JSON parse (escapes RAW newlines/tabs the model
  leaves inside string values, strips fences) with prose fallback. Shared by the
  server (`summarize`), client (`coerceMessages`/render), and `npm run check`.
- `lib/llm-log.ts` + `lib/llm-db-log.ts`: best-effort log of each model call's system
  instruction, prompt, raw response, `duration_ms`, Replicate `predict_time_ms`, and
  input/output token counts (parsed from the Gemini prediction `logs` text in
  `lib/replicate.ts#runModel` — Gemini reports usage there, not in `metrics`).
  `game`/`platform`/`user_id` are logged on every call (client sends `userId`;
  validated as a UUID in `/api/solve`). File tail in
  `llm-log.json` (dev / `LLM_LOG=1`); Supabase table `public.llm_calls`
  (`db/llm-calls.sql`) when `NEXT_PUBLIC_SUPABASE_*` are set (`LLM_DB_LOG=0`
  disables). Insert-only RLS — no client reads.
- `lib/games.js`: `mapGames(payload)` maps a TheGamesDB `ByGameName?include=boxart`
  payload to `{ id, name, year, releaseDate, cover, platform }` (year from
  `release_date`, cover from the front box-art in the `include` block), dropping
  malformed entries. `prepareAutocompleteGames` dedupes noisy same-console
  duplicates and attaches a release-date hint when rows still differ.
  Covered by `npm run check`.
- PWA + brand: UI font is **Rubik** via `next/font` in `app/layout.tsx`. The logo is `GGG.png` (2000x2000 source, `#00FFAA` bg), resized with `sips` into
  static icons — `app/icon.png` (favicon), `app/apple-icon.png` (apple-touch),
  `public/icon-192.png` / `public/icon-512.png` (manifest `purpose: "any"`), and
  `public/logo.png` (nav brand mark, `<img>` in `app/page.tsx`). Maskable is a
  **separate** padded icon `public/icon-512-maskable.png` (`sips -Z 380` then
  `--padToHeightWidth 512 512 --padColor 00FFAA`) so Android's adaptive mask
  doesn't zoom/crop the tight-framed logo — never point `purpose: "maskable"` at
  the plain icon. Manifest `background_color`/`theme_color` are `#00FFAA` (Android
  splash). iOS ignores those, so `public/splash/apple-splash-<w>-<h>.png` (solid
  `#00FFAA` + centered logo, `sips` pad) are wired as `apple-touch-startup-image`
  `<link>` tags generated from `APPLE_SPLASH` in `app/layout.tsx` (curated
  portrait device set). Re-run the `sips` commands to regenerate from a new source.
  `public/sw.js` is a network-first service worker (cache `gg-runtime-v2`, evicts
  stale caches on activate) registered by `app/sw-register.tsx`. The `viewport`
  export in `app/layout.tsx` sets `maximumScale: 1` + `userScalable: false` to
  disable pinch-zoom (honored in the installed PWA; iOS Safari tabs ignore it by
  design).
- Persistence model: one `public.chats` row per saved game (`game`, `platform`,
  `preferred_guide_url`, `cover_url`, `release_year`, `messages` jsonb), RLS-scoped
  to `auth.uid()`; the client upserts the whole `messages` array each turn and
  reads with `select("*")` so it tolerates the cover columns being absent before
  the migration. Device-uploaded covers live in the public `covers` Storage bucket
  under an `<uid>/` prefix (RLS: owner writes, public read). Both are set up by
  `db/cover-metadata.sql`. `public.search_cache` is a shared public cache table
  (see Known limits).

## Known limits (ponytail)

- Stop/cancel threads the client `AbortController` → `/api/solve` `request.signal`
  → `AbortSignal.any([timeout, signal])` into the `replicate.run` calls
  (`lib/replicate.ts`) and every Tavily/Serper fetch (`lib/tavily.ts`), so `run()`'s
  built-in signal cancels the prediction. It relies on Vercel propagating the
  client disconnect to `request.signal` (nodejs runtime); if a disconnect isn't
  propagated the prediction may finish server-side (result discarded). Upgrade
  path for guaranteed cancel: `predictions.create` + tracked id + a `/cancel`
  endpoint (needs SSE to hand the id to the client mid-flight).
- iOS PWA splash images are a curated **portrait-only** device set
  (`APPLE_SPLASH` in `app/layout.tsx`); landscape/older devices fall back to the
  OS default. Edge-swipe uses fixed edge (24px) / threshold (60px) heuristics and
  is meant for the installed PWA (a browser tab's own back-gesture can fight the
  left edge).
- Model-call input fields are Gemini-specific; switching `REPLICATE_MODEL` to a
  non-Gemini model would silently drop `system_instruction`/`thinking_budget`.
- Chat history is sent as plain text inside the prompt and trimmed by turn count,
  not token count.
- Searches are cached in `public.search_cache` (7-day TTL) keyed by rewritten
  query + preferred URL, so repeat/popular queries skip Tavily. Every turn pays
  the `resolveQuestion` rewrite call (needed to build the key) even on a hit.
  Without Supabase env vars the cache no-ops and every turn re-runs the tiered
  search (up to 4 sequential `advanced` Tavily calls, ~2x credits vs `basic`).
- `search_cache` has permissive RLS (public select/insert/update via the anon
  key) so the server can write without a service-role secret. It only holds
  non-sensitive public web results the model already treats as untrusted, and the
  TTL self-heals; the ceiling is cache pollution, not a data leak. Upgrade path:
  move writes behind the service-role key or a `security definer` RPC.
- HLTB playtime uses the same permissive `hltb_cache` pattern (30d TTL). No
  single-flight lease or outbound token bucket yet — concurrent first-time misses
  for the same app can duplicate upstream searches; upgrade path: `claim_hltb_lease`
  + rate bucket like steamAntiFomo. HLTB's search path segment can rotate; update
  `SEARCH_SEG` in `lib/hltb-cache.js` when init/search starts 404ing.
- Preferred-guide site-search + extract feeds the model the `focusSection` window
  (capped at `EXTRACT_CONTENT_CAP`) of the picked page, targeted by query-term
  density — better than a fixed head slice for huge single-page guides, but still
  keyword density, not semantics; upgrade path is embeddings/chunk re-ranking. It
  trusts the user's site choice and skips the confidence gate.
- Every turn runs two sequential Gemini calls (`resolveQuestion` then
  `summarize`). `max_output_tokens` on the rewrite must stay generous (~200);
  too tight a cap returns empty even with thinking off.
- `summarize` asks for JSON (`answer` + `highlights`); `parseSummary` tolerates
  prose/markdown fences when the model drifts. ponytail: prompt-instructed JSON
  rather than `response_mime_type` (not exposed on Replicate's Gemini input).
- Flash on Replicate consumes ~1k tokens of reasoning overhead against
  `max_output_tokens` even with `thinking_budget: 0`, so `summarize` uses 4096
  to avoid truncated answers (1200 cut answers off after ~100 visible tokens).
- Relevance filtering can't separate same-series wrong-game guides (RE0 vs RE
  Code: Veronica score alike); the top-3 trim plus the "ignore off-game
  snippets" system rule mitigate it rather than fully solving it.
- The `CONFIDENCE_MIN`/`SCORE_WINDOW` thresholds in `lib/rank.js` are heuristics
  calibrated on a handful of real queries, not a learned cutoff; tune them there
  if answers cite too much or fall back to knowledge too often.
- Tavily still returns arbitrary page chunks (control lists, TOCs), not the
  section that answers the question; the model leans on its own knowledge.
- Game autocomplete + box art use TheGamesDB (single API key, web-friendly, but
  coverage/quality is patchier than IGDB and it has a monthly quota). IGDB has the
  best coverage and is the intended upgrade, gated only on Twitch app credentials;
  the provider swap is `app/api/games/route.ts` + `lib/games.js#mapGames`.
- Cover art is signed-in only (anon users get the plain fields, no Storage use).
  TheGamesDB covers are hotlinked from its CDN (zero Storage). Device uploads are
  held as a local `blob:` preview and written to the public `covers` bucket only at
  save time (`resolveCoverUrl` in the persist path), so abandoned picks never land
  in Storage. Bucket policy: owner-write under `<uid>/`, public read. Storage is
  cleaned to respect the free tier: deleting a chat removes its cover + all its
  message images, clearing a cover deletes its file, and replacing a cover deletes
  the one it replaced (`coverStoragePath` maps a public URL back to a bucket path;
  TheGamesDB CDN covers are skipped). Message images upload to `<uid>/msg/` at send.
- Autocomplete platform auto-fill depends on TheGamesDB returning
  `include=platform` and `tgdbPlatformToLabel` recognising the name; unknown names
  leave the selector untouched for manual choice.
- **Steam link + Supabase server auth:** `auth.updateUser()` on a server route
  fails with `Auth session missing!` if the Supabase client only has a bearer
  token in `global.headers` — `getUser()` still works, which is misleading.
  `POST /api/steam/link` must receive `refresh_token` and call `setSession`
  before `updateUser`. See [`docs/troubleshooting.md`](docs/troubleshooting.md)
  (Connect Steam section) before changing that flow.

## Commands

```bash
npm run dev
npm run check
npm run build
```

## Environment

Server-only secrets (never expose via `NEXT_PUBLIC_`, never commit `.env.local`):

- `REPLICATE_API_TOKEN` (required to answer).
- `TAVILY_API_KEY` (optional; enables supporting web search).
- `SERPER_API_KEY` (optional; Serper.dev fallback used only when Tavily is
  unconfigured or every Tavily call fails — quota/outage. Snippet-only, no extract).
- `REPLICATE_MODEL` (optional, default `google/gemini-2.5-flash`).
- `LLM_LOG` (optional; `1` enables the `llm-log.json` model-call log in
  production — it is on automatically in dev). `LLM_LOG_PATH` overrides the path.
- `LLM_DB_LOG` (optional; `0` disables writes to `public.llm_calls`. On by default
  when Supabase vars are set — apply `db/llm-calls.sql` first. Insert-only RLS).
- `THEGAMESDB_API_KEY` (optional; enables game-name autocomplete + box art via
  TheGamesDB). Missing key => the field degrades to free text. IGDB (Twitch
  `TWITCH_CLIENT_ID`/`SECRET`) is the intended eventual upgrade but not wired now.
- `STEAM_API_KEY` (optional; Steam Web API key for owned-games library import after
  OpenID login, plus the persona name/avatar on Sign in with Steam). Missing key =>
  Connect Steam / Steam library stay hidden or no-op. User's Steam profile Game
  details must be Public.
- `SUPABASE_SERVICE_ROLE_KEY` (optional, server-only; NEVER expose via
  `NEXT_PUBLIC_`). Enables **Sign in with Steam** by minting a Supabase account for
  the Steam identity (`/api/steam/session`). Without it the bridge 501s and Steam
  stays a link-only action on a Google/email account.

Public client vars (safe to expose; protected by RLS), optional — enable
accounts, saved chats, and the search cache:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key).
  Project `GameGuideGuru` (ref `luoymycbpnvamdtlzjem`). Google OAuth and email
  confirmation are configured in the Supabase dashboard.

## Working conventions

- Keep model/search provider calls server-side; Supabase auth/DB reads are
  client-side under RLS (the anon key is public by design).
- Validate browser input and all external API data.
- Keep the UI accessible; the only runtime dependency is `@supabase/supabase-js`.
- No login wall: signed-out users must keep full access.
- Preserve source links alongside every generated guide.
- Update this file when architecture, providers, commands, or environment
  requirements change significantly.

## Copywriting (brand voice)

All user-facing copy (buttons, labels, banners, toasts, empty states, alt text,
aria-labels, placeholders) follows this voice. It also applies to the model's
persona text in `lib/prompt.js`.

Voice: a helpful gaming buddy sitting next to you. Short, benefit-first, second
person, concrete. Calm and useful. Dry wit is fine. Never influencer hype, never
emoji spam, never panic urgency. English UI; the model still answers in the
player's language (Indonesian tone: relaxed, like chatting with a friend, "aku"
and "kamu", not stiff, no forced slang).

```
// BAD
"Unlock the ultimate guide — never get stuck again!"
"Oops! Something went wrong 😢"
"AI-powered answers to level up your gameplay"

// GOOD
"Stuck? Ask about any game and get a straight answer."
"Couldn't build a guide. Try again."
"Ask a follow-up and it remembers where you are."
```

Sound human, not like AI. Specifically avoid these tells:
- No em-dashes (`—`) or en-dashes as sentence punctuation (the clearest AI tell).
  Use a comma, period, parentheses, or "and"/"but". (En-dash `–` as a numeric or
  date *range* is fine; em-dashes inside code comments are fine.)
- No "it's not X, it's Y" / "not just X, but Y" constructions.
- No rule-of-three padding ("fast, simple, and reliable"), no "seamless",
  "effortless", "elevate", "unlock", "level up", "supercharge", "delve", "robust".
- Don't over-hedge or over-explain. Say the thing once.
