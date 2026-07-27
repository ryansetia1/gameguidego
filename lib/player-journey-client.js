import { getSupabase } from "./supabase";
import { saveJourneyEnabled } from "./player-journey-prefs.js";
import {
  disablePlayerJourney,
  enablePlayerJourney,
  JOURNEY_DISABLE_CONFIRM,
} from "./player-journey.js";

/** @param {unknown} value @param {number} max */
export function cleanJourneyText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** @param {string} path @param {RequestInit} [init] */
export async function journeyAuthedFetch(path, init) {
  const supabase = getSupabase();
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  if (!token) throw new Error("Sign in required.");
  return fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Shared enable/disable handler for page + profile shell.
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient | null,
 *   userId?: string,
 *   next: boolean,
 *   confirmDisable: (message: string) => Promise<boolean>,
 *   onError?: (message: string) => void,
 *   onDisabled?: () => void,
 * }} input
 */
export async function applyPlayerJourneyEnabled(input) {
  const { supabase, userId, next, confirmDisable, onError, onDisabled } = input;
  if (!next) {
    if (!(await confirmDisable(JOURNEY_DISABLE_CONFIRM))) {
      return { ok: false, cancelled: true };
    }
    if (supabase && userId) {
      try {
        await disablePlayerJourney(supabase, userId);
      } catch (error) {
        console.error("Failed to disable journey:", error);
        onError?.("Couldn't turn off progress tracking.");
        return { ok: false };
      }
    }
    saveJourneyEnabled(false);
    onDisabled?.();
    return { ok: true, enabled: false };
  }
  if (supabase && userId) {
    try {
      await enablePlayerJourney(supabase, userId);
    } catch (error) {
      console.error("Failed to enable journey:", error);
      onError?.("Couldn't turn on progress tracking.");
      return { ok: false };
    }
  }
  saveJourneyEnabled(true);
  return { ok: true, enabled: true };
}
