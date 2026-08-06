# Troubleshooting

Notes for humans and coding agents debugging recurring issues. Search this file
before changing auth, Steam link, or preferred-guide retrieval code.

## Preferred guide: the answer misses a section that clearly names what was asked

### Symptom

- The player asks about a named thing ("after beating the Slime Eyes boss") and the
  answer either covers something else or says the guide does not discuss it.
- The guide *does* contain a paragraph about it. Reading `guide_chunks` confirms it.
- `rag_db_check` in the trace shows `lexicalHits: 0` while `lexicalPhrases` looks
  correct.

### Root cause

`match_guide_chunks_hybrid` failed and `fetchCandidates` (`lib/guide-rag.ts`) fell back
to vector-only `match_guide_chunks`. The fallback exists so an install that never
applied `db/guide-chunks-hybrid.sql` still works, but it also swallows a *runtime*
failure, most importantly a statement timeout on a large guide. The feature then looks
enabled while doing nothing, and degrades on exactly the big guides it was built for.

Cosine alone ranks poorly inside one walkthrough: every paragraph reads "go north,
defeat the X, open the chest". In the case this note comes from, the answering chunk
sat at cosine rank 16 of 20.

### How to confirm

1. Server log for `match_guide_chunks_hybrid unavailable` (logged **once per process**,
   so restart the server before looking, or check an older log).
2. Run the phrase straight against the DB. If it matches rows here but `lexicalHits` is
   0, the RPC is the problem, not the extraction:

```sql
select count(*) from public.guide_chunks
where guide_url = '<url>'
  and chunk_tsv @@ to_tsquery('english', '(slime <-> eye)');
```

3. `node scripts/test-hybrid-retrieval.mjs` — four unrelated games, fails if this path
   degrades.

### Fix

Apply `db/guide-chunks-hybrid.sql`. It stores the tsvector in a generated `chunk_tsv`
column with a GIN index instead of building it per query (timeout → 30 ms on a
1093-chunk guide) and marks the `scoped` CTE `not materialized`.

### Misdiagnosis traps

- **Blaming proper-noun extraction first.** It is structural (capitalisation and
  sentence position), so it is easy to suspect. Check the RPC before touching it.
- **A colon is not a sentence end.** Guides write "Level 3: Key Cavern"; treating the
  colon as a break makes "Key" look sentence-initial and the phrase collapses to
  "cavern". Fixed, but the same class of bug is easy to reintroduce.
- **The game's own name is a useless phrase.** "Link" appears in most chunks of a
  Link's Awakening guide. `extractEntityPhrases` takes the game name to drop phrases
  built only from title words.
- **A loose end-to-end assertion.** The Pokémon case in the harness once asserted only
  that some excerpt said "Gardenia", which the *entering the gym* chunk satisfies, so it
  passed while a regression was live. Assert on text only the answering chunk contains.

### Related files

- `lib/guide-rag.ts` — `fetchCandidates`, the fallback, `rag_db_check` trace
- `lib/guide-lexical.js` — phrase extraction, `retrievalScore`
- `db/guide-chunks-hybrid.sql` — `chunk_tsv`, GIN index, the RPC
- `scripts/test-hybrid-retrieval.mjs` — live guard

## Connect Steam: OpenID succeeds but account never links

### Symptom

- User clicks **Connect Steam**, signs in on Steam, returns to the app.
- Sidebar still shows **Connect Steam** (not **Steam library**).
- No user-visible error in the common case (`no_steam_session` is swallowed).
- Server log: `Steam link failed: Auth session missing!`
- `POST /api/steam/link` returns `500` with `{ "error": "link_failed" }`.

Earlier steps usually **work**: `GET /api/steam/login` redirects to Steam,
`GET /api/steam/callback` verifies OpenID and sets the `gg_steam` cookie, and the
client sees `/?steam=linked`.

### Root cause

`@supabase/supabase-js` on the **server** treats read and write auth differently:

| API | Bearer token in `global.headers` only |
|-----|----------------------------------------|
| `auth.getUser()` | Works — validates the JWT directly |
| `auth.updateUser()` | **Fails** — requires a hydrated client session |

A server route that does this will pass `getUser()` but fail at link time:

```ts
createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
});
await supabase.auth.getUser();      // ok
await supabase.auth.updateUser();   // throws "Auth session missing!"
```

Client-side `updateUser()` (e.g. profile menu) works because the browser client
already holds a full session.

### Fix (required pattern)

1. **Client** (`linkSteamToAccount` in `app/page.tsx`): send `access_token` in
   `Authorization` and `refresh_token` in the POST body.
2. **Server** (`app/api/steam/link/route.ts`): `setSession({ access_token,
   refresh_token })`, then `updateUser({ data: { steam_id } })`.

Do **not** “fix” this by switching to the service-role key unless you deliberately
want admin-style user updates — the refresh-token + `setSession` path is the
intended design here.

### Misdiagnosis traps

- **`GET /api/steam/me` returns `steamId: null` while signed in** — intentional.
  When authenticated, that route trusts only `user_metadata.steam_id`, not the
  `gg_steam` device cookie. Do not use it to decide whether linking can proceed;
  the cookie is consumed by `POST /api/steam/link`.
- **OpenID / callback / cookie issues** — if callback logs show verification
  success and `gg_steam` is set, the failure is almost certainly the Supabase
  session pattern above, not Steam OpenID.
- **Pre-checking `/api/steam/me` before link** — was a prior bug: it always
  returned null for unlinked authed users and aborted linking before
  `POST /api/steam/link` ran.

### Related files

- `app/page.tsx` — `linkSteamToAccount`, `?steam=linked` handler
- `app/api/steam/link/route.ts` — persists `steam_id` to `user_metadata`
- `app/api/steam/callback/route.ts` — sets `gg_steam` after OpenID
- `lib/steam-session.js` — HMAC cookie signing/verification
