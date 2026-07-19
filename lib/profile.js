export const MAX_DISPLAY_NAME_LENGTH = 32;

/** @param {unknown} value @returns {string} */
export function coerceDisplayName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
}

/** @param {unknown} metadata @returns {string} */
export function displayNameFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  const record = /** @type {Record<string, unknown>} */ (metadata);
  return (
    coerceDisplayName(record.display_name) ||
    coerceDisplayName(record.full_name) ||
    coerceDisplayName(record.name)
  );
}

/** @param {unknown} v @returns {string | null} */
function httpUrl(v) {
  return typeof v === "string" && v.startsWith("http") ? v : null;
}

/**
 * The avatar candidates an account has, by source. `google` covers OAuth
 * (`picture`/`avatar_url`) and legacy accounts; `steam` is refreshed on each
 * Steam login; `upload` is a user-uploaded image. Absent sources are null.
 * @param {{ user_metadata?: unknown } | null | undefined} user
 */
export function avatarSourcesFromUser(user) {
  const metadata = user?.user_metadata;
  const r = /** @type {Record<string, unknown>} */ (
    metadata && typeof metadata === "object" ? metadata : {}
  );
  return {
    google: httpUrl(r.picture) || httpUrl(r.avatar_url),
    steam: httpUrl(r.avatar_steam),
    upload: httpUrl(r.avatar_upload),
  };
}

/**
 * The avatar to display. Honours the user's chosen source (`avatar_pref`) when
 * that source exists; otherwise falls back upload > google > steam so unifying a
 * Steam login into a Google account doesn't silently swap the Google photo.
 * @param {{ user_metadata?: unknown } | null | undefined} user
 * @returns {string | null}
 */
export function avatarUrlFromUser(user) {
  const metadata = user?.user_metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const pref = /** @type {Record<string, unknown>} */ (metadata).avatar_pref;
  const sources = avatarSourcesFromUser(user);
  if (typeof pref === "string" && sources[/** @type {keyof typeof sources} */ (pref)]) {
    return sources[/** @type {keyof typeof sources} */ (pref)];
  }
  return sources.upload || sources.google || sources.steam || null;
}

/**
 * @param {import("@supabase/supabase-js").User | null | undefined} user
 * @returns {string}
 */
export function avatarInitialFromUser(user) {
  const name = displayNameFromMetadata(user?.user_metadata);
  if (name) return name[0]?.toUpperCase() ?? "?";
  const email = user?.email?.trim();
  if (email) return email[0]?.toUpperCase() ?? "?";
  return "?";
}
