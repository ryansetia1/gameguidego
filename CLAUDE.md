# GameGuide Go

## Purpose

Mobile-first, installable (PWA) Next.js prototype that answers a player's game
question. The model (Gemini 2.5 Flash on Replicate) answers from its own
knowledge; tiered web search provides supporting evidence. Supports
TheGamesDB-backed game-name autocomplete (with box art; IGDB is the eventual
upgrade), a fuzzy/acronym-aware platform selector, multi-turn
follow-up chat, an optional preferred-guide source, and optional Supabase
accounts that save per-game chats. The UI is English; the model still answers in
the player's input language. No login wall: signed-out users keep full access;
chats persist on-device in `localStorage` (cap 20) via `lib/local-games.js` but
do not sync to the cloud or use Storage uploads.

## Architecture

- `app/page.tsx`: Layout orchestration (~1788 lines): chat list/session hydration,
  overlay history, examples strip, confirm/toast overlays. Composes
  `app/chat/use-home-session.tsx` (auth/Steam), `app/chat/use-guide-bundle.tsx`
  (guide ingest state/effects), `app/chat/games-sidebar.tsx`,
  `app/chat/home-setup.tsx` (hero, Jump back in carousel, setup form),
  `app/chat/active-game-card.tsx` (in-chat game card + guide stacks/bundle panels),
  `app/chat/message-list.tsx`, `app/chat/composer-shell.tsx`, and
  `app/chat/use-chat-turn.tsx` for the chat loop. English client chat UI (game
  field, platform, optional preferred-guide link, global major-spoiler toggle
  (profile menu + `user_metadata.spoiler_major`) and per-game major-spoiler toggle
  (setup **Spoilers** opt-tab + compact toggle on the game card;
  `loadGameSpoilerPrefs`/`saveGameSpoilerPrefs` in `lib/spoiler-prefs.js`;
  effective = global OR per-game), message feed, docked composer) and `/api/solve`
  consumer.
  Keeps `messages` state and sends the last 10 messages (5 turns) as `history`
  plus `preferredUrls` (up to 5) and `spoilerPrefs` (`major`, default off). Also owns Supabase auth state, the "Your games" menu
  (list/resume/new/delete), per-turn chat persistence (auto-creates a new saved
  chat when the game name changes mid-session), edit/retry on message bubbles,
  structured highlight sections on assistant replies, a game metadata card with
  box art (replaces the input fields once a chat starts; edit reopens the fields),
  cover art (signed-in only, to keep the anon flow simple and Storage-free):
  TheGamesDB box art plus optional device upload whose Storage write is DEFERRED to
  the first save (so abandoned drafts cost nothing), with a letter-tile placeholder
  fallback; autocomplete also auto-fills the platform selector via
  `tgdbPlatformToLabel`; a sticky mini-header (cover + game/platform; tap to
  scroll to top; its left control is a **burger** that opens the sidebar, since
  the top nav scrolls away — "home" lives on the brand logo (`goHome`) and a
  **Home** item at the top of the sidebar, not a back arrow),
  a collapsible left sidebar (burger toggle) that lists saved games (cover + game +
  platform·year) with a per-row kebab -> Edit/Delete menu and a Library button that
  opens a 2-column cover-art grid,   per-message image attachments (signed-in only: compressed client-side, one
  paperclip menu beside Send for photo library or camera, uploaded to the `covers` bucket at send time, sent
  to Gemini via Replicate's `images` field`; also **desktop drag-and-drop** and
  **paste** of image files into the composer (`dragActive` +
  `.composer.drag-active`/`.composer-dropzone` for drop, textarea `onPaste` for paste;
  both reuse `selectMessageImages`, signed-in + unlocked only); edit/retry drops truncated turns'
  Storage images), profile avatar menu (theme, spoilers, sign out) and `/profile`
  page for `user_metadata.display_name` (LLM uses it in prompts), theme via
  `gg:theme` / `user_metadata.theme`,
  light-markdown rendering of answers (`lib/markdown.js`: bold/lists/headings),
  a dismissable examples strip
  (remembered in `localStorage`; on home it renders **below** the composer so the
  composer stays above the fold), and auto-scroll (smooth on new turns, instant
  jump to the last user message when opening a saved game; scroll-to-bottom FAB
  hides once the last answer bubble is in view via `shouldShowScrollFabForBubble`
  in `lib/chat-scroll.js` + `lastGuideRef`, not only at page bottom). Refresh restores the open thread via `?chat=<id>`
  (signed-in saved chats) or a `sessionStorage` draft (`lib/chat-session.js`;
  anon / not-yet-saved). `runTurn`/`persistChat` centralise ask +
  save; `conversationGame` tracks which game the visible thread belongs to.
  **Server-Side Persistence:** `POST /api/solve` uses Next.js 15 `after()` to detach LLM generation and save directly to Supabase via the user's Auth token, guaranteeing the AI finishes even if the user force-closes the app. Signed-in saved chats: server is the canonical writer for the final assistant message (`lib/chat-persist.js`); client writes optimistic placeholders, polls `pollUntilMessagesRecovered`, and falls back to `persistChat` on timeout. Anon stays client-only (`localStorage`).
  **Background Polling:** if the UI drops the SSE stream on network sleep, it smoothly changes status to "Continuing process..." and polls Supabase to reattach to the background result.
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
  `/api/solve` fetch (`abortRef`); the client also fires a direct call to
  `/api/solve/cancel` which explicitly aborts the Replicate prediction (saving tokens).
  This Replicate-native cancel replaces the old `request.signal` abort to allow the background `after()` save to complete uninterrupted when the user merely backgrounds the app. A promise-based
  confirm dialog (`askConfirm(message, confirmLabel?, danger=true)` →
  `confirmState`) guards every destructive action (delete chat from the
  sidebar/game-card/library kebabs, clear cover, and edit/retry whenever it would
  drop follow-up turns — `confirmDropFollowups` in `use-chat-turn.tsx` confirms on
  any dropped turn, naming the message count and, when present, the attached-image
  count; retrying the last turn drops nothing so it stays confirm-free). Pass
  `danger:false` for a positive CTA (brand-accent button
  instead of red), e.g. the "Use your Steam account" offer. A themed `snackbar` (`toast`)
  confirms a successful Steam link. The game-card and saved-library cards use the
  sidebar kebab pattern (`menuOpenId`/`toggleRowMenu`) for Edit/Delete; the
  sticky-header burger opens the sidebar and `goHome` (pops the pushed chat entry)
  is reached via the brand logo / sidebar Home. Mobile
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
  **Saved library** / **Steam library** (when connected) buttons, and an ambient
  bottom-anchored one-line **tip** (`HomeTip` from `HOME_TIPS`, centered, fresh
  per open). `main` is a `min-height:100dvh` flex column and `.quick-home` grows
  (`flex:1`) only when the setup form is closed, so the tip sits at the screen
  bottom for balance but the setup form still flows right after the carousel with
  no gap. "+ New game" collapses the hero (`.hero-shell--exit`) and reveals the
  setup form below the carousel with a push-up entrance (`.setup--from-quick`).
  Sidebar + library are ungated for anon (Steam/profile controls stay `user`-only).
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
- `app/guide-link-field.tsx`: preferred-guide twin tabs — **Paste link** (add up to
  5 URLs) or **Search web** (queries `/api/guide-search` with game/platform +
  optional keywords; **Add** appends a hit to the list). Auto-runs a search when
  the tab opens if a game name is set. `lib/guide-urls.js` owns URL validation,
  dedupe, chat/draft coercion, and legacy `preferredUrl` / `preferred_guide_url`
  fallback.
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
  `gg_steam` cookie, then redirects `/?steam=linked`. **Mobile-PWA popup flow:** both
  Steam entry points open `/api/steam/login?...&popup=1` in a `window.open` browser
  tab (not a top-level PWA nav, which the OS hands to the native Steam app and then
  returns to the browser instead of the PWA). With `popup=1` the callback returns a
  tiny self-closing HTML page that `postMessage`s `{gg:"steam",intent|error}` to the
  opener and closes; `page.tsx` handles it via a `message` listener + shared
  `handleSteamReturn` (the old `?steam=` redirect stays as the popup-blocked
  fallback). A successful `signin` also closes the still-open auth modal
  (`loginWithSteam` returns a boolean). The client links **only**
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
  history, preferredUrls, spoilerPrefs, playerName }` at the trust boundary (history capped to 10, content
  truncated, `preferredUrls` capped/deduped via `lib/guide-urls.js`, `spoilerPrefs` coerced to booleans,
  `playerName` from `display_name`, max 32 chars). Always calls `resolveQuestion`
  to rewrite the query into standalone English. When any preferred URL is set, runs
  preferred-guide RAG (`lib/guide-rag.ts`: lazy ingest all URLs, embed query,
  pgvector retrieve across `guide_url = any($urls)`, similarity-route at
  `GUIDE_HIT`); on a high-similarity hit the retrieved chunks are marked
  `preferred` and tiered web search is skipped. On a low-similarity miss (or when
  RAG infra is unset) falls back to tiered Tavily/Serper search. Without preferred
  URLs, tiered search only (cached in `lib/search-cache.ts` keyed by `searchQuery`).
  Search is best-effort (skipped if no search API key, failures swallowed); the model
  still answers. Returns `{ answer, highlights, sources, spoilers, guideHint? }`
  (`spoilers` trimmed to `[]` when `spoilerPrefs.major` is false). `sources` are
  deduped by URL and the RAG "(section N)" title suffix is stripped, so multiple
  chunks from one guide page don't render as duplicate links to the same URL
  (no real per-section anchors exist); uploaded-file sources (`upload://`) render
  as plain non-clickable text in the UI. `question` accepts up to 2000 chars
  (composer `maxLength` matches). Only `REPLICATE_API_TOKEN` is mandatory.
- `app/api/guide-bundle/route.ts`: `GET ?url=` previews GameFAQs multi-page FAQ
  bundles (page count + section list) before the user confirms add. Discovery
  uses `lib/gamefaqs-discover.ts` (site search + extract TOC enrichment; GameFAQs
  blocks direct HTML fetch). `GET /api/guide-bundle/status?url=` returns bundle
  title + discovery page list from `guide_bundle_cache` and per-page indexed rows
  from `guide_chunks` (Supabase only, no Tavily). Used for the game-card
  (`app/bundle-index-panel.tsx`: missing pages listed first with Skip/Include
  controls and optional Retry; toast names failed sections via `pagesMissing`.
  Page pick at add time in `app/guide-link-field.tsx`; skip/select prefs in
  `lib/bundle-prefs.js` (`localStorage` `gg:bundle-prefs`; signed-in users sync
  `user_metadata.bundle_prefs` across devices, skip union + selected remote-wins).
  Discovery merges Tavily search (base + per-part when sparse), extract TOC,
  `public.guide_bundle_cache` (30d TTL, `db/guide-bundle-cache.sql`), and pages
  already in `guide_chunks` so partial runs accumulate over time. Game-card loading:
  inline spinner on the guide link (not a skeleton); collapsible index panel after
  meta + status fetches complete. See **GameFAQs multi-page bundles** below.
- `app/api/guide-ingest/route.ts`: lazy shared ingest for one or more preferred
  guide URLs (GameFAQs bundles expand to discovered TOC pages, filtered by
  `bundlePrefs` skip/include). Accepts `game`/`platform`/`userId` for embed audit
  logs. Skips re-ingest client-side when all target pages are indexed. Returns
  `pagesMissing` when bundle sections fail extract/embed. Orphan pre-bundle root
  rows are deleted on ingest.
- `app/api/guide-ingest/status/route.ts`: lightweight read-only endpoint checking
  the indexing status (indexed: true/false) of any preferred guide URL without triggering ingest.
- `lib/gamefaqs-bundle.js`: GameFAQs FAQ autodetect, TOC discovery, bundle
  canonical URL normalization (max 50 pages per bundle). Chunks store optional
  `guide_bundle` (`db/guide-bundle.sql`) for retrieval across all pages.
- `lib/guide-rag.ts` + `lib/guide-ingest.ts` + `lib/chunk-guide.js` +
  `lib/embed.ts` + `lib/embed-cache.ts`: preferred-guide RAG. Tavily extract the
  pasted page (`extractGuidePage`), structure-aware chunking (`chunkGuide`),
  text-embedding-3-large on Sumopod (OpenAI-compatible) (`EMBED_MODEL`, default
  `text-embedding-3-large`), shared `public.guide_chunks` + `match_guide_chunks`
  RPC (pgvector, 1024-dim). Query embeddings cached in `public.embed_cache` (7-day
  TTL). Fail-open to tiered web search when Supabase/pgvector/Sumopod API key is unset.
  Also supports **file uploads** (PDF/TXT/MD) via `POST /api/guide-upload` —
  files are parsed in memory (zero storage), chunked, and embedded into the same
  `guide_chunks` table with a synthetic `upload://<uid>/<filename>` key.
  `lib/parse-guide-file.ts` handles PDF extraction (pdf-parse) and plain text.
  Full design: [`docs/preferred-guide.md`](docs/preferred-guide.md).
  Embedding model specs & migration checklist: [`docs/embedding-models.md`](docs/embedding-models.md).
- `lib/tavily.ts`: `searchGuides(query)` orchestrates Tavily tiered search then a
  Serper.dev fallback; `extractGuidePage(url)` pulls full page text for RAG ingest
  (**Tavily Extract only** — Serper cannot replace this); `discoverGuideLinks(...)`
  powers the guide picker (Tavily then Serper fallback). See provider fallback
  notes under Known limits.
- `lib/search-cache.ts`: best-effort Supabase-backed cache of `searchGuides`
  output (`getCachedSearch`/`setCachedSearch`, 7-day TTL). Uses the shared
  `getServerClient()` from `lib/supabase-server.ts`; no-ops when unset or
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
  (`max_output_tokens`, `thinking_budget: 0`), polls prediction status to yield granular `status` events (e.g. "Starting AI engine") to the UI during generation, and parses the JSON
  `{ answer, highlights, spoilers, spoilerRisk }` via `lib/highlights.js#parseSummary`.
  All Gemini calls (`resolveQuestion`, `summarize`, `censorSpoilers`) share a single
  `Replicate` SDK instance (`getReplicate()` singleton). Preferred-guide **Phase C
  rerank** lives in `lib/guide-rerank-cohere.ts` (`cohereRerankChunks`): a Cohere
  `rerank-v3.5` cross-encoder that reorders the retrieved top-K and returns a
  `relevant` verdict the RAG router trusts over raw cosine (calibration 2026-07-22:
  cosine 9/10 rank-1 3/6 → Cohere 10/10 rank-1 6/6; a Gemini LLM-reranker was tried
  and deleted for regressing to 8/10). Opt-in by `COHERE_API_KEY` presence and fully
  fail-open — any Cohere error (trial expired / 429 / network) falls back to cosine
  `GUIDE_HIT`, so it's safe to enable. See `docs/plan/rag-tuning-roadmap.md`.
  `/api/solve` calls `censorSpoilers` when spoilers are OFF and `spoilerRisk` is
  true (best-effort rewrite; fails open). `resolveQuestion({ question, history, forRag? })`
  does a small Gemini call: short web-search query (≤15 words) by default, or a
  longer contextual retrieval query (~60 words) when `forRag` is set for preferred-guide
  RAG embed. Falls back to the raw question on any failure. Exports the
  `Turn`, `Highlight`, `SpoilerReveal`, and `SummaryResult` types.
- `lib/profile.js`: `display_name` / avatar helpers for the profile menu and page.
  `avatarUrlFromUser` is pref-aware: it honours `user_metadata.avatar_pref`
  (`google`/`steam`/`upload`) when that source exists, else falls back
  upload > google > steam (so unifying a Steam login into a Google account keeps
  the Google photo). `avatarSourcesFromUser` exposes the per-source URLs
  (`picture`/`avatar_url`, `avatar_steam`, `avatar_upload`) for the `/profile`
  photo picker. The picker uploads to the `covers` bucket (`<uid>/avatar-*.jpg`)
  and writes `avatar_upload` + `avatar_pref`.
- `app/clear-button.tsx`: shared trailing "clear the field" button (`ClearButton`).
  Wrap a text input in `.field-clear-wrap` (position:relative) and drop it after the
  input; renders nothing when empty. Used on the game-name field, platform search,
  saved + Steam library search, guide web-search, and profile display name; the
  composer uses it as a flex sibling (`.composer-clear`) so it never overlays the
  growing textarea. `preventDefault` on mousedown keeps comboboxes from blurring
  before clear. Skipped: auth email/password and the guide-URL paste field (already
  has paste/info controls + an Add button that clears it).
- `lib/image.js`: `compressImage(file, maxDim, quality)` — client-side canvas
  downscale + JPEG re-encode shared by covers, message images, and avatar upload.
- `lib/spoiler-prefs.js`: global **major spoiler** toggle (`major`, default off)
  in `localStorage` (`gg:spoiler-major`; signed-in users sync `user_metadata.spoiler_major`)
  plus per-game overrides in `gg:spoiler-prefs` keyed by normalized game name.
  `effectiveSpoilerPrefs(global, game)` ORs them for each turn. `buildSpoilerBlock`
  + `buildSpoilerOutputRules` for the summarize prompt (LLM filters to genuinely
  major twists; routine walkthrough stays in `answer`; when OFF the model may set
  `spoilerRisk` for a second-pass censor), `coerceSpoilerPrefs` at the API trust
  boundary. Covered by `npm run check`.
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
  history, imageCount, spoilerPrefs, playerName })` (sources may carry
  `preferred: true` for RAG chunks — labels them PREFERRED GUIDE and injects a
  fidelity directive; adds a visual-context note when images are attached;
  **experimental** character-naming rules when `imageCount > 0` (`IMAGE_CHARACTER_RULES`
  — see [`docs/plan/image-character-recognition.md`](docs/plan/image-character-recognition.md):
  patut dicoba, riskan; full revert steps there); when images are attached, rewrite
  output (`imageResolvedSubject` / `searchTopic`) is also injected as a soft visual
  anchor so summarize does not drift from a correct rewrite (same doc, section B);
  section C adds history-poisoning guards + image-trust hedging on the anchor;
  section D (validated live, trace `66f59c23`) strips prior Guide (assistant) IDs
  from the rewrite history on image turns (`app/api/solve/route.ts`) so an "ini"
  follow-up re-reads the current image instead of inheriting a past character, plus
  a silent-correction rule (`IMAGE_SILENT_CORRECTION`) so a re-read never narrates
  an apology. Known ceiling: confident misID on obscure characters is NOT fixable
  prompt-only (Pandemona returned 3 different confident wrong names across fresh
  chats); only self-consistency voting would surface it — not yet shipped.
  `playerName` only on the first turn — follow-ups get a no-greeting rule to stop
  repeated "hello again" salutations),
  plus `REWRITE_INSTRUCTION` + `buildRewritePrompt({ question, history })` for
  query rewriting. Covered by `npm run check`.
- `lib/highlights.js`: `KINDS`/`KIND_LABELS`, `coerceHighlights(value)`, and
  `parseSummary(text)` — tolerant JSON parse (escapes RAW newlines/tabs the model
  leaves inside string values, strips fences) with prose fallback. Shared by the
  server (`summarize`), client (`lib/chat-messages.js#coerceMessages`/render), and `npm run check`.
- `lib/llm-log.ts` + `lib/llm-db-log.ts`: best-effort log of each model call's system
  instruction, prompt, raw response, `duration_ms`, Replicate `predict_time_ms`, and
  input/output token counts (parsed from the Gemini prediction `logs` text in
  `lib/replicate.ts#runModel` — Gemini reports usage there, not in `metrics`).
  `game`/`platform`/`user_id` are logged on every call (client sends `userId`;
  validated as a UUID in `/api/solve`). Kinds: `rewrite`, `summarize`, `censor`,
  plus `embed_index` / `embed_query` from `lib/embed-log.ts` (guide ingest batches
  and per-turn RAG query embeds, including cache hits). File tail in
  `llm-log.json` (dev / `LLM_LOG=1`, async writes to avoid blocking the event
  loop); Supabase table `public.llm_calls`
  (`db/llm-calls.sql`, patch `db/llm-calls-embed.sql` on older installs) when
  `NEXT_PUBLIC_SUPABASE_*` are set (`LLM_DB_LOG=0` disables). Insert-only RLS — no client reads.
- `lib/supabase-server.ts`: shared server-side Supabase client
  (`getServerClient()`, anon key, no session). All server modules — caches
  (`search-cache`, `embed-cache`, `hltb-cache`, `guide-bundle-cache`), logs
  (`llm-db-log`, `solve-log`), RAG (`guide-rag`), and ingest (`guide-ingest`) —
  import from this single module instead of each maintaining a private singleton.
  Separate from `lib/supabase.ts` (`getSupabase`) which is the browser client
  used by `page.tsx` (with auth session).
- `lib/hero-copy.js`: rotating home copy — `FUN_ROLES` (eyebrow
  "Companion for …", cycles on a timer; tap pauses/resumes), `HERO_LINES`
  (`[hook, payoff]` headline pairs; one picked at random per open; index 0 is the
  SSR-stable default), and `HOME_TIPS` (short feature tips for the quick-home
  bottom `HomeTip`; index 0 SSR-stable). Hero `h1` is sized to track the
  quick-home headline on mobile (`clamp(2.4rem, 11.5vw, 6.1rem)`) so long two-part
  lines never spill to 4 rows and push the composer below the fold.
- `app/profile-menu.tsx`: signed-in nav avatar dropdown — link to `/profile`,
  global spoiler toggle, theme picker (System/Light/Dark via `lib/theme.js`),
  sign out. Theme/spoiler writes sync to `user_metadata` when signed in.
- `lib/games.js`: `mapGames(payload)` maps a TheGamesDB `ByGameName?include=boxart`
  payload to `{ id, name, year, releaseDate, cover, platform }` (year from
  `release_date`, cover from the front box-art in the `include` block), dropping
  malformed entries. `prepareAutocompleteGames` dedupes noisy same-console
  duplicates and attaches a release-date hint when rows still differ.
  Covered by `npm run check`.
- PWA + brand: UI font is **Rubik** via `next/font` in `app/layout.tsx`. **Theme
  rules** (no rounded corners, tokens, layout): [`docs/ui-theme.md`](docs/ui-theme.md).
  The logo is `GGG.png` (2000x2000 source, `#00FFAA` bg), resized with `sips` into
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
  `preferred_guide_url` (legacy first URL), `preferred_guide_urls` (text[]; see
  `db/preferred-guide-urls.sql`), `cover_url`, `release_year`, `messages` jsonb), RLS-scoped
  to `auth.uid()`; the client upserts the whole `messages` array each turn and
  reads with `select("*")` so it tolerates the cover columns being absent before
  the migration. Device-uploaded covers live in the public `covers` Storage bucket
  under an `<uid>/` prefix (RLS: owner writes, public read). Both are set up by
  `db/cover-metadata.sql`. `public.search_cache` is a shared public cache table
  (see Known limits).

## GameFAQs multi-page bundles (agent reference)

Full design doc: [`docs/preferred-guide.md`](docs/preferred-guide.md). This section
is the behaviour contract agents must not skip.

### When it applies

- Any preferred-guide URL matching `/faqs/{id}/` on `gamefaqs.gamespot.com` is a
  **bundle** (`isGamefaqsBundleUrl` in `lib/guide-urls.js`). One URL in the user's
  list expands to many indexed pages under `guide_bundle = gamefaqs:{faqId}`.

### Discovery (page list — not indexing yet)

GameFAQs blocks direct HTML fetch (Cloudflare 403). `lib/gamefaqs-discover.ts`
(`discoverGamefaqsBundleResolved`) is the single entry point for preview + ingest.

**Two modes** (`DiscoverOptions.refresh`):

| Mode | When | Tavily? |
|------|------|---------|
| **Cache-first** (default) | `GET /api/guide-bundle` (add-time preview only) | No — reads `guide_bundle_cache` + `guide_chunks` |
| **Full refresh** (`?refresh=1`) | Add-bundle preview, **Refresh page list** button | Yes — full pipeline below |

Full refresh pipeline:

1. **Direct fetch** (`discoverGamefaqsBundle` in `lib/gamefaqs-bundle.js`) when
   Cloudflare allows (rare).
2. **Tavily Extract** introduction / walkthrough / root → `parseGamefaqsTocFromHtml`.
3. **Tavily Site Search** (`searchDiscoveryUrls`, up to 30 hits/query):
   - Base queries (`buildGamefaqsDiscoveryBaseQueries`): path-wide, part-, walkthrough,
     boss, faq, game name.
   - If merged pages **< 12** (`PART_QUERY_PAGE_THRESHOLD`), per-part queries
     (`buildGamefaqsPartDiscoveryQueries`): `part-1`…`part-25`,
     `walkthrough-part-1`…`15`, plus common slugs (faq, boss-guides, etc.).
4. **TOC enrichment**: extract up to 6 seed pages (intro, walkthrough, part-1, faq)
   and merge any extra TOC links found in extracted text.
5. **Merge sources (union, never shrink)**:
   - Fresh discovery
   - `public.guide_bundle_cache` (`lib/guide-bundle-cache.js`, 30d TTL,
     `db/guide-bundle-cache.sql`) keyed by `bundle_key`
   - Pages already in `guide_chunks` for that bundle (`getIndexedBundlePagesFromDb`)
6. Upsert merged list back to `guide_bundle_cache`.

**Indexing** uses cache-first discovery first; runs full refresh only when a target
`includeSlug` has no URL in the cached list.

**Important:** Tavily Search is **not** a full site crawler. A guide may have 20+
real pages while discovery finds 12–18. Pages **never discovered** have no URL to
index; pages **discovered but extract failed** can retry. Discovery can **grow**
across runs via cache union; it does not guess missing slugs.

`MAX_BUNDLE_PAGES = 50` in `lib/gamefaqs-bundle.js` is the app cap, not the cause
of ~16-page discovery gaps.

### Add-bundle UX (`app/guide-link-field.tsx`)

- Paste bundle URL → `GET /api/guide-bundle?refresh=1` preview → checkbox list of discovered
  pages (Select all / Clear) → **Add bundle (N pages)**.
- `selectedSlugs` saved to `lib/bundle-prefs.js` + `guideBundleMeta` on the client.
  Panel and ingest only track those slugs when set (`filterBundlePanelPages`).

### Bundle prefs (`lib/bundle-prefs.js`)

Per canonical bundle URL (`gg:bundle-prefs` in `localStorage`; signed-in users also
`user_metadata.bundle_prefs`):

- `selectedSlugs`: pages user chose at add time (ingest `includeSlugs`).
- `skippedSlugs`: user Skip on game card (ingest `skipSlugs`); union across devices
  on login; `selectedSlugs` remote-wins when both devices set a selection.
- `clearBundlePrefs()`: wipes `gg:bundle-prefs` and resets the sync state; called
  on sign-out to prevent cross-account pref bleed on shared devices.

Sent to server as `bundlePrefs` on `POST /api/guide-ingest` and `POST /api/solve`.
`buildBundlePrefsBody` in `page.tsx` prefers UI state (`guideBundleMeta`) over
`localStorage` so the server always gets the selection the user sees on-screen,
even when `localStorage` writes fail (private browsing, quota). After ingest
completes, the `finally` block does a final `/api/guide-bundle/status` read to
verify actual indexed state before clearing the progress indicator.

### Indexing (`lib/guide-ingest.ts`, `POST /api/guide-ingest`)

- Runs before first solve turn per guide URL (and from `lib/guide-rag.ts` on solve).
- **Pre-database check**: queries `guide_chunks` for existing URLs *before* invoking Tavily extract, drastically saving credits and latency on repeat ingest attempts.
- **Resume**: per-page idempotent — failed/missing pages retried on next turn.
- **Skip ingest when done**: client skips `POST /api/guide-ingest` when
  `bundleHasPendingPages` is false (all target slugs indexed or skipped) or when local `guideIndexState` confirms a single-page guide is already indexed. Server `isGuideIndexed` includes a canonical URL fallback to gracefully handle GameFAQs single-page URLs submitted with arbitrary query parameters (e.g. `?page=1`).
- Filters discovery by `skipSlugs` / `includeSlugs` from `bundlePrefs`.
- Deletes orphan pre-bundle root chunks on bundle ingest.
- Returns `pagesMissing` (failed, not skipped), `pagesIndexed`, `pageCount` (target
  after filters). Toast via `guideIngestHintFromResponse` names missing page titles.
- Sequential per-URL ingest; Tavily extract batches (`INGEST_EXTRACT_BATCH_SIZE`,
  default 5) with delay. `maxDuration = 300` on the route.
- Embed audit: `embed_index` rows in `llm_calls` (`lib/embed-log.ts`).

### Game card UI (`app/chat/active-game-card.tsx`, `app/bundle-index-panel.tsx`)

Guide links and bundle panels are paired in `.game-card-guide-stack` (full card
width, one stack per preferred URL). Spoiler toggle is in `.game-card-spoiler`
below all guides (game-level, not per guide). See [`docs/ui-theme.md`](docs/ui-theme.md).

One Supabase-only fetch per bundle URL on load / `bundleStatusRev` bump:

| Fetch | Endpoint | Backend | Purpose |
|-------|----------|---------|---------|
| Panel state | `/api/guide-bundle/status` | `getBundleIndexStatus` → `guide_bundle_cache` + `guide_chunks` | Title, page list, indexed rows |
| Add preview | `/api/guide-bundle?refresh=1` | full Tavily discovery | Before user confirms add |
| Refresh list | `/api/guide-bundle?refresh=1` | full Tavily discovery | User-triggered; costs credits |

`bundlePanelLoad` tracks `{ meta, status }` per URL. While loading:

- **Inline spinner** (`.game-card-bundle-spinner`) beside `IconArrowUpRight` on the
  guide link — **no vertical skeleton** (saves space).
- Collapsible `BundleIndexPanel` hidden until the status fetch completes.

Panel when loaded:

- Summary: `Indexed X of Y (your selection)` when `selectedSlugs` set; missing/skipped counts.
- Missing rows first, **Skip** / **Include**, **Retry missing pages**, **Ignore remaining pages**
  (bulk skip), **Refresh page list** (full Tavily discovery).
- `missingPages` excludes `skippedSlugs` and slugs outside `selectedSlugs`; merges ingest
  `pagesMissing` + discovery minus indexed.

### RAG per turn (`lib/guide-rag.ts`)

- `retrieveFromPreferredGuides` ingests (with `bundlePrefs`), embeds query
  (`embed_query` in `llm_calls`), `match_guide_chunks` with `GUIDE_HIT` threshold.
- High hit → `skipWebSearch: true`; else tiered Tavily + one chunk fallback.
- **DO NOT add an ANN index (ivfflat/hnsw) on `guide_chunks.embedding`.**
  Retrieval always filters by `guide_url`/`guide_bundle` first (btree), then does an
  EXACT cosine sort on that ≤~dozens-of-rows subset — fast + 100% recall. A prior
  ivfflat index (`lists=100`, default `probes=1`) made the planner use it for the
  ORDER BY and return only ~1 (approximate, often WRONG) chunk per query on the tiny
  per-guide set — which surfaced as a preferred-guide answer drifting off the guide
  even though `hit=true`. Removed in `db/guide-chunks.sql`; re-add hnsw only for
  unfiltered global KNN over 100k+ chunks.

### Skipped Refactors (Tier 3)

The following Tier 3 cleanup tasks were deliberately skipped to prioritize stability:

- **Dead-page pruning (`lib/gamefaqs-discover.ts`)**: Currently uses union-only merge
  for discovery caches (`mergeGamefaqsBundlePages`). This means 404'd pages are never
  dropped. We skipped implementing a hard prune or overwrite mode to avoid the risk of
  losing valid pages (and triggering excessive Tavily fallback searches) if an extraction
  transiently fails.
- **Deleting `guideBundleMeta` derived cache (`app/page.tsx`)**: The `guideBundleMeta`
  React state duplicates data from `bundleIndexStatus` (server) and `getBundlePrefs`
  (localStorage), causing multiple drift classes. We skipped the "mini-rewrite" to
  remove it because it touches almost all panel render logic and is highly error-prone.
  If drift becomes a critical issue, future agents should remove `guideBundleMeta` entirely
  and compute its properties on the fly (e.g. `missingPages = discovery \setminus indexed`).
- Debug retrieval with `RAG_DEBUG=1` → logs `[rag-calibrate] hit=… top=… scores=[…]
  top_chunk=…` per query (scores should have several entries, not one; top_chunk
  should match the question). This is the fastest way to tell a retrieval miss
  (wrong/too-few chunks) from a generation miss (right chunk, model ignored it).


### Self-heal cheat sheet

| Case | Auto-fix? |
|------|-----------|
| Discovered, extract failed | Retry next turn / Retry button |
| Indexed in DB, dropped from new discovery | Merged back from `guide_chunks` + cache |
| New discovery finds more pages later | Cache union adds them |
| Never discovered (no URL) | No — needs better discovery or user Skip |
| User Skip | Stops retry; excluded from missing toast |

### DB tables (apply SQL in `db/`)

- `guide_chunks` + `guide_bundle` column (`db/guide-bundle.sql`)
- `guide_bundle_cache` — discovery TOC cache
- `embed_cache`, `search_cache`, `llm_calls` (incl. `embed_index`, `embed_query`)

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
  query + preferred URL, so repeat/popular queries skip Tavily. A preliminary
  cache (`rewrite::hash`) prevents running the `resolveQuestion` rewrite call
  on exact input cache hits.
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
- Preferred-guide RAG (`GUIDE_HIT` in `lib/guide-rag.ts`) is a hand-tuned cosine
  threshold, not a learned router. Chunking is recursive boundary-split in
  `lib/chunk-guide.js`, not semantic. Ingest has no single-flight lease (unique
  index guards dup rows; concurrent first-time ingests of the same URL can
  duplicate upstream embed work). Query-embed cache is best-effort (`embed_cache`).
  Given page only; hub/multi-page guides rely on the user pasting the real page
  (surfaced via optional `guideHint` toast; ingest failures toast from
  `POST /api/guide-ingest` before solve, with solve as fallback).
- **Preferred-guide RAG cost ceiling (cannot blow up per turn):** retrieval uses
  `match_guide_chunks` with `LIMIT` (`RETRIEVE_K = 5` in `lib/guide-rag.ts`) —
  the full ingested guide never goes to Gemini, only up to five stored chunks.
  Each chunk is sized at ingest (~500 tokens, `TARGET_CHARS` in
  `lib/chunk-guide.js`). On a high-similarity hit, Gemini `summarize` gets those
  five chunks plus rewrite/history/question (~3k–5k input tokens for research,
  not 50k+). On a miss: one best chunk + tiered web search (3 snippets × 800
  chars). **To spend less (future tuning):** (1) lower `RETRIEVE_K` (5 → 3) in
  `lib/guide-rag.ts`; (2) add a per-source `content` cap in `buildPrompt` (e.g.
  1500 chars) as a safety net if ingest ever stores one giant chunk; (3) raise
  `GUIDE_HIT` so more turns fall back to shorter Tavily snippets instead of five
  RAG chunks; (4) shorten the RAG rewrite cap in `resolveQuestion` (`forRag`
  `maxChars` / `REWRITE_RAG_INSTRUCTION` word limit). Do not remove the SQL
  `LIMIT` or send unbounded `guide_chunks` rows to `summarize`.
- Every turn runs two sequential Gemini calls (`resolveQuestion` then
  `summarize`). A preferred-guide RAG turn adds **one Cohere rerank HTTP call only
  when `COHERE_API_KEY` is set**; unset adds nothing and routes on cosine
  `GUIDE_HIT`. Web rewrite `max_output_tokens` ~200; preferred-guide RAG rewrite
  ~400 (`forRag`). Too tight a cap returns empty even with thinking off.
- `solve_logs.pipeline_type` now correctly records `"rag"` when preferred-guide
  RAG succeeds (`skipWebSearch`). Error-path `totalLatencyMs` uses `startedAt`
  (was previously `Date.now() - Date.now()` ≡ 0).
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
- **Search/extract provider fallback (important):** not all Tavily uses share the
  same backup. **Answer-time search** (`searchGuides`, `discoverGuideLinks`):
  Tavily Search → Serper.dev fallback (snippet-only). **Preferred-guide ingest**
  (`extractGuidePage` in `lib/tavily.ts`): **Tavily Extract only** — Serper has no
  page-extract API, so a **new** guide URL cannot be indexed when `TAVILY_API_KEY`
  is missing or Extract is down/quota-blocked (already-indexed URLs in
  `guide_chunks` keep working). Upgrade path for ingest resilience: (1) direct
  fetch + `cleanSnippet`/`readability` fallback (fragile on JS sites); (2) a
  dedicated extract provider wired beside Tavily in `extractGuidePage`. **Brave
  Search API (not wired):** standard `/web/search` is another snippet search —
  could back up Serper/Tavily Search, not Extract. Brave **LLM Context**
  (`/llm/context`) is query→ranked web chunks for grounding/RAG-style answers,
  not “extract this pasted URL in full” for one-time `guide_chunks` ingest; wrong
  shape unless we redesign ingest around search+`site:` (would miss off-page
  structure and still wouldn't mirror full-book chunking). Evaluate Brave for
  answer-time search before ingest.
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
- `TAVILY_API_KEY` (optional for chat; **required to index new preferred guides**
  via Extract. Enables supporting web search + guide picker).
- `SERPER_API_KEY` (optional; Serper.dev fallback when Tavily **Search** fails or
  is unconfigured — snippet-only, **does not** replace Tavily Extract for ingest).
- `REPLICATE_MODEL` (optional, default `google/gemini-2.5-flash`).
- `COHERE_API_KEY` (optional, server-only; its **presence** enables the Phase C
  preferred-guide reranker — no other flag. Unset = route on cosine `GUIDE_HIT`.
  Fully fail-open: trial-expired / 429 / network errors fall back to cosine. Trial
  keys are free (10 req/min, non-commercial); swap in a paid key later with no code
  change). `COHERE_RERANK_MODEL` (default `rerank-v3.5`), `COHERE_RELEVANCE_MIN`
  (default `0.3`; top score below this routes to web fallback).
- `SUMOPOD_API_KEY` (required for preferred-guide RAG).
- `SUMOPOD_BASE_URL` (optional, default `https://ai.sumopod.com/v1`).
- `EMBED_MODEL` (optional, default `text-embedding-3-large`; preferred-guide
  RAG embedder. Swapping dims requires re-ingest).
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
  Project `GameGuideGuru` (ref `luoymycbpnvamdtlzjem`). Apply `db/guide-chunks.sql`
  and `db/embed-cache.sql` (pgvector extension) for preferred-guide RAG. Google OAuth and email
  confirmation are configured in the Supabase dashboard.

## Roadmap plans

Long-horizon refactors live in [`docs/plan/`](docs/plan/README.md). Read before
large chat or persistence work:

- [`docs/plan/chat-persistence-refactor.md`](docs/plan/chat-persistence-refactor.md):
  Phase 0–1: `lib/chat-messages.js` + `lib/chat-persist.js` (variant coercion, single
  writer). Phase 2: `db/chat-threads.sql` (`chat_turns`, `chat_responses`,
  `chat_turn_state` keyed by `chat_id` → `chats.id`), `lib/chat-thread.js` +
  `lib/chat-thread-persist.js` (canonical rows + `chats.messages` write-only cache;
  `trace_id` on each response). Phase 3: `scripts/backfill-chat-threads.mjs`
  backfills legacy JSONB; signed-in reads use `resolveThreadMessages` (`pickRicherThread`
  over normalized + legacy JSONB cache). Server `after()` uses `loadMessagesForServerMerge`
  when normalized sync lags; client awaits pre-solve tail sync (`syncThreadFromMessages`
  `mode: "tail"`) and skips error revert when the server already persisted the answer.
  Routine persist uses tail upsert; edit/retry/variant-nav use full sync.
  Apply `db/chat-threads.sql` before using in prod.
- [`docs/plan/chat-persistence-cutover-fixes.md`](docs/plan/chat-persistence-cutover-fixes.md):
  Phases 1–7 done (read fallback, server merge, sync reliability, hook split:
  `turn-persist.tsx`, `execute-chat-turn.ts`, `solve-stream.ts`).
- [`docs/plan/page-decomposition.md`](docs/plan/page-decomposition.md): Phase 4 —
  `app/chat/message-list.tsx`, `composer-shell.tsx`, `use-chat-turn.tsx`,
  `answer-body.tsx`, `types.ts`, `lib/chat-message-ui.js`, `lib/guide-card-ui.js`,
  `games-sidebar.tsx`, `active-game-card.tsx`, `home-setup.tsx`, `cover-thumb.tsx`,
  `hero-marketing.tsx`, `guide-status-chip.tsx`, `spoiler-toggle.tsx`,
  `use-guide-bundle.tsx`, `use-home-session.tsx` extracted;
  `app/page.tsx` ~1788 lines (orchestration + chat list + overlays).
- [`docs/plan/rag-tuning-roadmap.md`](docs/plan/rag-tuning-roadmap.md): RAG quality
  research (chunk size, `RETRIEVE_K`, `GUIDE_HIT` calibration, reranker vs learned
  router). Phased backlog for the next preferred-guide upgrade; no runtime change yet.
- [`docs/plan/image-character-recognition.md`](docs/plan/image-character-recognition.md):
  **Experimental (shipped, prompt-only):** vision character naming on image attachments.
  Worth trying in production; revert via `git revert` or manual `lib/prompt.js` rollback
  if wrong IDs, spoiler leaks, or worse search/RAG queries.
- [`docs/plan/user-memory.md`](docs/plan/user-memory.md): **Experimental (shipped):**
  opt-in signed-in **Learn my style** — incremental daily summarize into structured
  profile (`player_memory_state` + `player_game_memory`; apply `db/player-memory.sql`),
  5 user messages = draft soft inject, 10 = full, `/profile` UI + **Update now**,
  disable wipes memory; cron `GET /api/cron/player-memory` (needs `CRON_SECRET` +
  `SUPABASE_SERVICE_ROLE_KEY`).

## Working conventions

- Keep model/search provider calls server-side; Supabase auth/DB reads are
  client-side under RLS (the anon key is public by design).
- Validate browser input and all external API data.
- Keep the UI accessible; the only runtime dependency is `@supabase/supabase-js`.
- No login wall: signed-out users must keep full access.
- Preserve source links alongside every generated guide.
- **CRITICAL LINTING RULE**: Setiap kali mengedit file React komponen (`.tsx`) atau TypeScript (`.ts`), Anda WAJIB menjalankan linter (misalnya melalui npm run lint atau mengecek *warning* pada IDE) dan memperbaiki semua error seperti pelanggaran *Rules of Hooks*, missing imports, dsb sebelum menyatakan tugas selesai kepada Tuan muda.
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

- Admin dashboard: `/admin` Activity tab (chat/ingest rows with LLM prompts, web search snippets, Cohere rerank, API call counts + **IDR cost estimates at today's USD/IDR rate** via `GET /api/admin/fx-rate` / Frankfurter) plus `/admin/traces` **Live traces** tab (flat live feed + grouped timelines, processing traces open by default). Real-time via Supabase on `solve_logs`, `ingest_logs`, `trace_events`, `llm_calls`. API spend labels: Tavily, Replicate, Cohere, **Sumopod embed** (future: Sumopod resolve/summarize keys reserved). Apply `db/admin-logs-policies.sql`.

## Trace Audit Fixes (July 2026)

### Fix 1: Discovery Short-Circuit for Indexed Guides
- In `ingestGamefaqsBundle` (`lib/guide-ingest.ts`), added a `countBundleChunks` check before calling `discoverGamefaqsBundleResolved`. If chunks already exist for the bundle, skip discovery entirely and return `indexed: true` immediately.
- This eliminates 11+ wasted Tavily API calls per question on already-indexed guides (~23s and ~$0.11 saved per request).

### Fix 3: Full Trace Instrumentation
- **`lib/embed.ts`**: Added `embed_query_start`, `embed_query_end`, `embed_query_cache_hit`, `embed_texts_start`, `embed_texts_end` trace events. The 96-second black hole (embedding model cold start) is now fully visible.
- **`lib/gamefaqs-discover.ts`**: Added `discovery_cache_hit` and `discovery_cache_miss` trace events in `discoverGamefaqsBundleCacheFirst`.
- **`app/api/solve/route.ts`**: Added `generation_complete` trace event after answer generation.
- **`lib/guide-ingest.ts`**: Added `discovery_skipped` trace event when the short-circuit fires.
