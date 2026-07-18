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

/**
 * @param {import("@supabase/supabase-js").User | null | undefined} user
 * @returns {string | null}
 */
export function avatarUrlFromUser(user) {
  if (!user || typeof user !== "object") return null;
  const metadata = user.user_metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (metadata);
  if (typeof record.avatar_url === "string" && record.avatar_url.startsWith("http")) {
    return record.avatar_url;
  }
  if (typeof record.picture === "string" && record.picture.startsWith("http")) {
    return record.picture;
  }
  return null;
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
