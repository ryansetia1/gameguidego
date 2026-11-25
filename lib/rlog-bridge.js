/**
 * Server side of the RLog bridge (#71). GGG's backend proxies RLog's
 * /api/integration/* with RLOG_BRIDGE_SECRET and the signed-in user's VERIFIED email
 * (from the Supabase session, never from the client). Every "no RLog for you" case
 * (no session, unverified email, bridge unset, RLog 401/404, no matching game) returns
 * the same 200 body, so the client renders nothing and can't tell the cases apart.
 *
 * Pure of Next.js: routes pass the verified user, env and fetch; scripts/check.mjs
 * drives it with a fake secret and a mocked fetch.
 */
import { normGameKey } from "./game-room.js";
import { platformLabelFor } from "./platforms.js";
import { buildRlogProgressContext } from "./rlog-checklist.js";

export const RLOG_DEFAULT_BASE = "https://r-log.vercel.app";
export const UNMATCHED = Object.freeze({ matched: false });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const CTRL = /[\u0000-\u001f\u007f<>]/;
// Sign in with Steam mints confirmed accounts under this reserved, fake domain.
const SYNTHETIC_DOMAIN = "@steam.gameguidego.local";
const UPSTREAM_TIMEOUT_MS = 10_000;

const unavailable = () => ({ status: 502, body: { error: "unavailable" } });
const unmatched = () => ({ status: 200, body: UNMATCHED });

/**
 * The email RLog may see: the session's own address, only when confirmed.
 * @param {{ email?: unknown, email_confirmed_at?: unknown } | null | undefined} user
 */
export function bridgeEmail(user) {
  const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
  if (!email || !user?.email_confirmed_at) return "";
  if (email.endsWith(SYNTHETIC_DOMAIN) || !EMAIL.test(email)) return "";
  return email;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ base: string, secret: string } | null}
 */
export function rlogConfig(env) {
  const secret = (env.RLOG_BRIDGE_SECRET ?? "").trim();
  if (!secret) return null;
  try {
    const url = new URL((env.RLOG_BASE_URL ?? "").trim() || RLOG_DEFAULT_BASE);
    if (url.protocol !== "https:") return null;
    return { base: url.origin, secret };
  } catch {
    return null;
  }
}

/** @param {unknown} v @param {number} max */
function text(v, max) {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

/** @param {unknown} v */
function count(v) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0;
}

/** @param {unknown} v */
function httpsUrl(v) {
  if (typeof v !== "string") return "";
  try {
    return new URL(v).protocol === "https:" ? v.slice(0, 1000) : "";
  } catch {
    return "";
  }
}

/** @param {any} g */
function cleanGame(g) {
  if (!g || typeof g !== "object" || typeof g.rlog_item_id !== "string" || !UUID.test(g.rlog_item_id)) {
    return null;
  }
  const igdb = Number.isInteger(g.igdb_id) && g.igdb_id > 0 ? g.igdb_id : null;
  const done = count(g.progress?.done);
  return {
    rlog_item_id: g.rlog_item_id,
    title: text(g.title, 200),
    platform: text(g.platform, 60),
    cover: httpsUrl(g.cover),
    igdb_id: igdb,
    progress: { done, total: Math.max(done, count(g.progress?.total)) },
  };
}

/** @param {string} p */
function platformKey(p) {
  return platformLabelFor(p) || p.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The RLog game behind a GGG room: same IGDB id first, else same normalized
 * title and platform.
 * @param {ReturnType<typeof cleanGame>[]} games
 * @param {{ igdb: number | null, game: string, platform: string }} room
 */
export function matchPlayingGame(games, { igdb, game, platform }) {
  const list = games.filter(Boolean);
  if (igdb != null) {
    const hit = list.find((g) => g?.igdb_id === igdb);
    if (hit) return hit;
  }
  const key = normGameKey(game);
  if (!key) return null;
  const plat = platformKey(platform);
  return list.find((g) => g && normGameKey(g.title) === key && platformKey(g.platform) === plat) ?? null;
}

/**
 * GET /api/rlog/checklist query: `igdb` (raw IGDB id) and/or `game` (+ `platform`).
 * @param {URLSearchParams} params
 * @returns {{ igdb: number | null, game: string, platform: string } | null}
 */
export function parseChecklistQuery(params) {
  const igdbRaw = params.get("igdb");
  const game = params.get("game") ?? "";
  const platform = params.get("platform") ?? "";
  if (igdbRaw !== null && !/^\d{1,10}$/.test(igdbRaw)) return null;
  if (game.length > 120 || platform.length > 60 || CTRL.test(game) || CTRL.test(platform)) return null;
  const igdb = igdbRaw === null ? null : Number(igdbRaw);
  if (igdb === 0 || (igdb === null && !game.trim())) return null;
  return { igdb, game: game.trim(), platform: platform.trim() };
}

/**
 * POST /api/rlog/checklist body.
 * @param {unknown} body
 * @returns {{ item_id: string, checklist_item_id: string, done: boolean } | null}
 */
export function parseToggleBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { item_id, checklist_item_id, done } = /** @type {Record<string, unknown>} */ (body);
  if (typeof item_id !== "string" || !UUID.test(item_id)) return null;
  if (typeof checklist_item_id !== "string" || !UUID.test(checklist_item_id)) return null;
  if (typeof done !== "boolean") return null;
  return { item_id, checklist_item_id, done };
}

/**
 * One RLog call. `null` means the network failed. Never logs: headers carry the secret.
 * @param {{ cfg: { base: string, secret: string }, email: string, fetchImpl: typeof fetch, signal?: AbortSignal }} id
 * @param {string} path  e.g. "playing?item=…"
 * @param {{ method?: string, body?: unknown }} [init]
 */
async function call({ cfg, email, fetchImpl, signal }, path, init = {}) {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${cfg.base}/api/integration/${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${cfg.secret}`,
        "X-Rlog-User-Email": email,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const data = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.ok && data === null ? 502 : res.status, data };
  } catch {
    return null;
  }
}

/** RLog said "not this account / not theirs" (or our secret is wrong): hide everything.
 * A 400 is not here: inputs are validated before the call, so it is a bug worth surfacing. */
const isUnmatched = (/** @type {number} */ s) => s === 401 || s === 403 || s === 404;

/**
 * @typedef {{ user: any, env: Record<string, string | undefined>, fetchImpl?: typeof fetch, signal?: AbortSignal }} Ctx
 * @typedef {{ status: number, body: Record<string, unknown> }} Result
 */

/** @param {Ctx} ctx */
function identity(ctx) {
  const cfg = rlogConfig(ctx.env);
  const email = bridgeEmail(ctx.user);
  return cfg && email ? { cfg, email, fetchImpl: ctx.fetchImpl ?? fetch, signal: ctx.signal } : null;
}

/** GET /api/rlog/playing → `{ matched: true, games }` or UNMATCHED. @param {Ctx} ctx @returns {Promise<Result>} */
export async function rlogPlaying(ctx) {
  const id = identity(ctx);
  if (!id) return unmatched();
  const res = await call(id, "playing");
  if (!res) return unavailable();
  if (isUnmatched(res.status)) return unmatched();
  if (res.status !== 200 || !Array.isArray(res.data?.games)) return unavailable();
  return { status: 200, body: { matched: true, games: res.data.games.map(cleanGame).filter(Boolean) } };
}

/**
 * GET /api/rlog/checklist?igdb=&game=&platform= → `{ matched: true, game, chapters, items }`
 * for the room's playing RLog game, or UNMATCHED.
 * @param {Ctx & { params: URLSearchParams }} ctx @returns {Promise<Result>}
 */
export async function rlogChecklist(ctx) {
  const room = parseChecklistQuery(ctx.params);
  if (!room) return { status: 400, body: { error: "Invalid query" } };
  const id = identity(ctx);
  if (!id) return unmatched();
  const get = (/** @type {string} */ q) => call(id, `playing?${q}`);

  let res = room.igdb != null ? await get(`igdb=${room.igdb}`) : null;
  if (!res || res.status !== 200) {
    if (res && !isUnmatched(res.status)) return unavailable();
    const list = await call(id, "playing");
    if (!list) return unavailable();
    if (isUnmatched(list.status)) return unmatched();
    if (list.status !== 200 || !Array.isArray(list.data?.games)) return unavailable();
    const hit = matchPlayingGame(list.data.games.map(cleanGame), room);
    if (!hit) return unmatched();
    res = await get(`item=${encodeURIComponent(hit.rlog_item_id)}`);
  }
  if (!res) return unavailable();
  if (isUnmatched(res.status)) return unmatched();
  const game = cleanGame(res.data);
  if (res.status !== 200 || !game) return unavailable();

  const chapters = (Array.isArray(res.data.checklistChapters) ? res.data.checklistChapters : [])
    .filter((/** @type {any} */ c) => typeof c?.id === "string" && UUID.test(c.id))
    .map((/** @type {any} */ c) => ({ id: c.id, title: text(c.title, 200) }));
  const items = (Array.isArray(res.data.checklistItems) ? res.data.checklistItems : [])
    .filter((/** @type {any} */ s) => typeof s?.id === "string" && UUID.test(s.id))
    .map((/** @type {any} */ s) => ({
      id: s.id,
      chapter_id: typeof s.chapter_id === "string" ? s.chapter_id : "",
      title: text(s.title, 500),
      done: s.done === true,
      ...(text(s.note, 500) ? { note: text(s.note, 500) } : {}),
    }));
  return { status: 200, body: { matched: true, game, chapters, items } };
}

/**
 * POST /api/rlog/checklist { item_id, checklist_item_id, done } → `{ matched: true, done }`.
 * A 409 (edited elsewhere meanwhile) is retried once.
 * @param {Ctx & { body: unknown }} ctx @returns {Promise<Result>}
 */
export async function rlogToggle(ctx) {
  const input = parseToggleBody(ctx.body);
  if (!input) return { status: 400, body: { error: "Invalid body" } };
  const id = identity(ctx);
  if (!id) return unmatched();
  const post = () => call(id, "checklist", { method: "POST", body: input });
  let res = await post();
  if (res?.status === 409) res = await post();
  if (!res) return unavailable();
  if (isUnmatched(res.status)) return unmatched();
  if (res.status !== 200 || res.data?.ok !== true) return unavailable();
  return { status: 200, body: { matched: true, done: res.data.done === true } };
}

const ARCHIVED = new Set(["completed", "dropped"]);
const STATUSES = new Set(["playing", ...ARCHIVED]);

/** @param {any} g */
function cleanStatusGame(g) {
  const base = cleanGame(g);
  if (!base || !STATUSES.has(g.status)) return null;
  return { rlog_item_id: base.rlog_item_id, igdb_id: base.igdb_id, title: base.title, platform: base.platform, status: g.status };
}

/** GET /api/rlog/status → `{ matched: true, games: [{ …, status }] }` or UNMATCHED (#73). @param {Ctx} ctx @returns {Promise<Result>} */
export async function rlogStatus(ctx) {
  const id = identity(ctx);
  if (!id) return unmatched();
  const res = await call(id, "status");
  if (!res) return unavailable();
  if (isUnmatched(res.status)) return unmatched();
  if (res.status !== 200 || !Array.isArray(res.data?.games)) return unavailable();
  return { status: 200, body: { matched: true, games: res.data.games.map(cleanStatusGame).filter(Boolean) } };
}

/**
 * Jump back in (#73): rooms whose RLog game is `completed` or `dropped` drop out.
 * `statusGames` null (not matched, loading, bridge down) = every room stays.
 * A room matching both a playing and a finished entry stays (playing wins).
 * @template {{ game?: string | null, platform?: string | null, catalog_game_id?: number | null }} R
 * @param {R[]} rooms
 * @param {{ igdb_id: number | null, title: string, platform: string, status: string }[] | null} statusGames
 * @param {number} igdbOffset  IGDB_ID_OFFSET (catalog ids are offset IGDB ids)
 * @returns {R[]}
 */
export function activeRooms(rooms, statusGames, igdbOffset) {
  if (!statusGames?.length) return rooms;
  const ordered = [...statusGames].sort((a, b) => Number(a.status !== "playing") - Number(b.status !== "playing"));
  return rooms.filter((r) => {
    const cat = r.catalog_game_id;
    const igdb = typeof cat === "number" && cat > igdbOffset ? cat - igdbOffset : null;
    // @ts-ignore status rows share the fields matchPlayingGame reads
    const hit = matchPlayingGame(ordered, { igdb, game: r.game ?? "", platform: r.platform ?? "" });
    return !(hit && ARCHIVED.has(/** @type {any} */ (hit).status));
  });
}

const SOLVE_TIMEOUT_MS = 2500;

/**
 * Anti-spoiler progress block for /api/solve (#73): the room's playing RLog checklist,
 * shaped by `buildRlogProgressContext`. Never throws; any failure, timeout or
 * no-match is "" so the answer goes out as usual.
 * @param {Ctx & { room: { igdb: number | null, game: string, platform: string }, timeoutMs?: number }} ctx
 * @returns {Promise<string>}
 */
export async function rlogProgressForSolve(ctx) {
  const abort = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    const params = new URLSearchParams();
    if (ctx.room.igdb != null) params.set("igdb", String(ctx.room.igdb));
    params.set("game", ctx.room.game);
    params.set("platform", ctx.room.platform);
    const res = await Promise.race([
      rlogChecklist({ ...ctx, params, signal: abort.signal }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve(null);
        }, ctx.timeoutMs ?? SOLVE_TIMEOUT_MS);
      }),
    ]);
    const body = /** @type {any} */ (res)?.body;
    return res && /** @type {any} */ (res).status === 200 && body?.matched ? buildRlogProgressContext(body) : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
