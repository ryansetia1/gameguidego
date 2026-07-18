import crypto from "node:crypto";

const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const OWNED_GAMES_URL = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/;

export const PENDING_STEAM_COOKIE = "pending_steam_id";
export const OPENID_STATE_COOKIE = "openid_state";
export const OPENID_STATE_MAX_AGE = 60 * 10;

/** Cryptographically random OpenID state (URL-safe). */
export function newOpenIdState() {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Constant-time string compare for CSRF state.
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {string} origin App origin, e.g. https://example.com
 * @param {string} state CSRF nonce echoed on return_to
 */
export function buildSteamLoginUrl(origin, state) {
  const returnTo = `${origin}/api/steam/callback?s=${state}`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `${STEAM_OPENID}?${params}`;
}

/**
 * @param {string} claimedId
 * @returns {string | null}
 */
export function steamIdFromClaimedId(claimedId) {
  if (typeof claimedId !== "string") return null;
  const match = claimedId.match(CLAIMED_ID_RE);
  return match ? match[1] : null;
}

/**
 * @param {Record<string, string>} queryParams
 * @returns {Promise<string | null>}
 */
export async function verifySteamOpenId(queryParams) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams)) {
    if (key.startsWith("openid.")) body.set(key, value);
  }
  body.set("openid.mode", "check_authentication");

  let text = "";
  try {
    const response = await fetch(STEAM_OPENID, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    text = await response.text();
  } catch {
    return null;
  }

  if (!/is_valid\s*:\s*true/i.test(text)) return null;
  return steamIdFromClaimedId(queryParams["openid.claimed_id"] ?? "");
}

/** @param {number | string} appId */
export function steamLibraryCoverUrl(appId) {
  return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
}

/**
 * @param {unknown} metadata
 * @returns {string | null}
 */
export function steamIdFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (metadata).steam_id;
  if (typeof raw === "string" && /^\d{5,}$/.test(raw)) return raw;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return String(Math.trunc(raw));
  return null;
}

/**
 * @param {string} steamId
 * @param {string} apiKey
 * @returns {Promise<Array<{ appId: number, name: string, playtimeMinutes: number, cover: string }>>}
 */
export async function fetchOwnedGames(steamId, apiKey) {
  const url = new URL(OWNED_GAMES_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", steamId);
  url.searchParams.set("include_appinfo", "1");
  url.searchParams.set("include_played_free_games", "1");
  url.searchParams.set("format", "json");

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Steam owned games failed with status ${response.status}`);
  }

  const payload = await response.json();
  const games = payload?.response?.games;
  if (!Array.isArray(games)) return [];

  return games
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const appId = "appid" in entry ? entry.appid : undefined;
      const name = "name" in entry && typeof entry.name === "string" ? entry.name.trim() : "";
      if (typeof appId !== "number" || !name) return [];
      const playtimeMinutes =
        "playtime_forever" in entry && typeof entry.playtime_forever === "number"
          ? entry.playtime_forever
          : 0;
      return [
        {
          appId,
          name,
          playtimeMinutes,
          cover: steamLibraryCoverUrl(appId),
        },
      ];
    })
    .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
}
