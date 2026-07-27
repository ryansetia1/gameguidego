export const JOURNEY_ENABLED_KEY = "gg:player-journey";

/** @param {unknown} metadata @returns {boolean | null} */
export function journeyEnabledFromUserMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (metadata);
  if (!("player_journey_enabled" in record)) return null;
  return record.player_journey_enabled === true;
}

/** @returns {boolean} */
export function loadJourneyEnabled() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(JOURNEY_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

/** @param {boolean} enabled */
export function saveJourneyEnabled(enabled) {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(JOURNEY_ENABLED_KEY, "1");
    else window.localStorage.removeItem(JOURNEY_ENABLED_KEY);
  } catch {
    // private mode
  }
}
