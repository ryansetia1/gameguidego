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

/** Exact `guide_chunks.guide_url` prefix owned by one user.
 * @param {string} uid */
export function uploadPrefix(uid) {
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
