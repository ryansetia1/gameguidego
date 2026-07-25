// Global "auto reference images" preference. When on (the default), the model's
// query rewrite decides per turn whether the player is asking what something looks
// like and, if so, fetches one reference image. One profile-level off-switch — no
// per-topic toggle. Mirrors the global spoiler pref shape (lib/spoiler-prefs.js).

export const VISUAL_AUTO_KEY = "gg:visual-auto";
export const VISUAL_SEARCH_TOGGLE_LABEL = "Reference images";

/** Default ON. Only an explicit "0" turns it off. @param {unknown} value @returns {boolean} */
export function coerceVisualAuto(value) {
  if (typeof value === "boolean") return value;
  if (value === "0" || value === 0 || value === "false") return false;
  return true;
}

/** @param {unknown} metadata @returns {boolean | null} */
export function visualAutoFromUserMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const value = /** @type {Record<string, unknown>} */ (metadata).visual_auto;
  return typeof value === "boolean" ? value : null;
}

/** @returns {boolean} */
export function loadVisualAuto() {
  if (typeof window === "undefined") return true;
  try {
    // Absent key => default ON; only a stored "0" means off.
    return window.localStorage.getItem(VISUAL_AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

/** @param {boolean} enabled */
export function saveVisualAuto(enabled) {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.removeItem(VISUAL_AUTO_KEY);
    else window.localStorage.setItem(VISUAL_AUTO_KEY, "0");
  } catch {
    // private mode
  }
}
