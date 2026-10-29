import { gameRoomKey } from "./game-room.js";

/**
 * Identity rules for /api/guide-upload. The uid always comes from the verified
 * Bearer token; a client-sent userId is only compared against it, never trusted.
 */

/**
 * @param {string | undefined} verifiedUid
 * @param {unknown} clientUid
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function checkUploadIdentity(verifiedUid, clientUid) {
  if (!verifiedUid || typeof verifiedUid !== "string") {
    return { ok: false, status: 401, error: "Sign in to upload guide files." };
  }
  if (clientUid !== undefined && clientUid !== null && clientUid !== "" && String(clientUid).trim() !== verifiedUid) {
    return { ok: false, status: 403, error: "That upload does not belong to your account." };
  }
  return { ok: true };
}

/**
 * Whether the client may drop an uploaded guide's row after a DELETE answered `status`.
 * 403 = the key is not this account's, so there is nothing of theirs to purge and the row
 * must still be removable; 500/503/401 keep the row so the user sees the error and retries.
 * @param {number} status
 */
export function dropRowAfterDelete(status) {
  return (status >= 200 && status < 300) || status === 403;
}

/** Exact `guide_chunks.guide_url` prefix owned by one user.
 * @param {string} uid */
function uploadPrefix(uid) {
  return `upload://${uid}/`;
}

/** True only for a non-empty key under this user's own upload prefix.
 * @param {unknown} uid
 * @param {unknown} guideUrl */
export function ownsUploadKey(uid, guideUrl) {
  return (
    typeof uid === "string" &&
    uid.length > 0 &&
    typeof guideUrl === "string" &&
    guideUrl.startsWith(uploadPrefix(uid)) &&
    guideUrl.length > uploadPrefix(uid).length
  );
}

/**
 * Rows of `chats` that reference an upload key, minus the room the caller is acting from.
 * @param {{ game?: string, platform?: string }[]} rows
 * @param {string} game
 * @param {string} platform
 */
export function countOtherRoomRefs(rows, game, platform) {
  const mine = gameRoomKey(game ?? "", platform ?? "");
  return rows.filter((r) => gameRoomKey(r.game ?? "", r.platform ?? "") !== mine).length;
}

/**
 * One element of a Postgres array literal, quoted so a comma, brace, quote or backslash in
 * the key cannot split or break it (postgrest-js `.contains` sends elements unquoted).
 * @param {string} s
 */
export function pgArrayElem(s) {
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * How many OTHER game rooms of this user still list `guideUrl` as a preferred guide
 * (RLS on `chats` scopes the authed client to the caller). Null when unknown: callers must
 * not purge or replace then. Uploads cannot be re-extracted, so a shared key must survive.
 * ponytail: check-then-act over SAVED chats only. An unsaved sessionStorage draft or a temporary
 * chat in another room is invisible here, and two rooms uploading the same key at the same
 * moment can both pass. Upgrade: per-room keys (upload://<uid>/<roomKey>/<file>).
 * @param {any} supabase authed (user-scoped) client
 * @param {string} guideUrl
 * @param {string} game
 * @param {string} platform
 * @returns {Promise<number | null>}
 */
export async function otherRoomReferences(supabase, guideUrl, game, platform) {
  try {
    const cols = "game, platform";
    const [a, b] = await Promise.all([
      supabase.from("chats").select(cols).filter("preferred_guide_urls", "cs", `{${pgArrayElem(guideUrl)}}`),
      supabase.from("chats").select(cols).eq("preferred_guide_url", guideUrl),
    ]);
    if (a.error || b.error) return null;
    return countOtherRoomRefs([...(a.data ?? []), ...(b.data ?? [])], game, platform);
  } catch {
    return null;
  }
}
