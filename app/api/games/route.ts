import { NextResponse } from "next/server";

import { IGDB_GAME_TYPES, mapIgdbGames, prepareAutocompleteGames } from "@/lib/games";

export const runtime = "nodejs";

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const IGDB_GAMES_URL = "https://api.igdb.com/v4/games";
const MAX_GAMES = 8;
// One game fans out to one row per platform, so allow more rows than games.
const MAX_ROWS = 14;

// Twitch app token (~60 days). Cached per server instance and refreshed on a 401
// or shortly before expiry; a cold start just fetches a new one.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getToken(clientId: string, clientSecret: string, force = false) {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const url = new URL(TWITCH_TOKEN_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("grant_type", "client_credentials");
  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Twitch token failed with status ${response.status}`);
  const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof json.access_token !== "string") throw new Error("Twitch token missing");
  const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
  cachedToken = { value: json.access_token, expiresAt: Date.now() + ttl * 1000 };
  return cachedToken.value;
}

function searchIgdb(token: string, clientId: string, query: string) {
  // IGDB's query language: strip quotes/backslashes from the user text.
  const term = query.replace(/["\\]/g, " ");
  return fetch(IGDB_GAMES_URL, {
    method: "POST",
    headers: { "Client-ID": clientId, Authorization: `Bearer ${token}`, Accept: "application/json" },
    body:
      `search "${term}"; ` +
      "fields name,first_release_date,cover.image_id,platforms.name; " +
      `where game_type = (${IGDB_GAME_TYPES.join(",")}); limit ${MAX_GAMES};`,
    signal: AbortSignal.timeout(8_000),
  });
}

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "")
    .trim()
    .slice(0, 100);

  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  // ponytail: no keys (or any failure) => autocomplete silently off, the field
  // still works as free text.
  if (!clientId || !clientSecret) {
    return NextResponse.json({ games: [], available: false });
  }

  if (query.length < 2) {
    return NextResponse.json({ games: [], available: true });
  }

  try {
    let response = await searchIgdb(await getToken(clientId, clientSecret), clientId, query);
    if (response.status === 401) {
      response = await searchIgdb(await getToken(clientId, clientSecret, true), clientId, query);
    }
    if (!response.ok) {
      throw new Error(`IGDB search failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    return NextResponse.json({
      games: prepareAutocompleteGames(mapIgdbGames(payload)).slice(0, MAX_ROWS),
      available: true,
    });
  } catch (error) {
    console.error("Game search failed:", error);
    return NextResponse.json({ games: [], available: false });
  }
}
