import { normGameKey } from "./game-room.js";
import { extractUserMessagesFromChats, MEMORY_DELTA_MESSAGE_CAP } from "./player-memory.js";

export const JOURNAL_BODY_MAX = 80_000;
export const JOURNAL_AUTO_DAILY_CAP = 20;
export const JOURNAL_DEBOUNCE_MS = 2 * 60 * 1000;
export const JOURNAL_MANUAL_PIN_MS = 15 * 60 * 1000;
export const JOURNAL_IN_FLIGHT_STALE_MS = 5 * 60 * 1000;
export const JOURNAL_REMINDER_MAX = 120;
export const JOURNAL_REMINDER_SUMMARY_MAX = 80;
export const JOURNAL_RETRIEVE_K = 5;
export const JOURNAL_SOURCE_URL = "journal://progress";

/** @param {string} url */
export function isJournalSourceUrl(url) {
  return typeof url === "string" && url.startsWith("journal://");
}

export const JOURNEY_TOGGLE_LABEL = "Track my progress";
export const JOURNEY_TOGGLE_HINT =
  "Keep a personal progress journal per game. Updates when you share new progress. Off by default.";
export const JOURNEY_DISABLE_CONFIRM = "Turn off and clear your progress journals?";
export const JOURNEY_EMPTY_HINT =
  "Tell me where you are and what you have. I'll track it here.";
export const JOURNEY_UPDATE_LABEL = "Update journal";

/** @param {unknown} metadata @returns {boolean} */
export function playerJourneyEnabledFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return false;
  return /** @type {Record<string, unknown>} */ (metadata).player_journey_enabled === true;
}

/** @param {string | null | undefined} reminder */
export function coerceJournalReminder(reminder) {
  if (typeof reminder !== "string") return "";
  return reminder.replace(/\s+/g, " ").trim().slice(0, JOURNAL_REMINDER_MAX);
}

/** @param {string | null | undefined} summary */
export function coerceJournalReminderSummary(summary) {
  if (typeof summary !== "string") return "";
  return summary.replace(/\s+/g, " ").trim().slice(0, JOURNAL_REMINDER_SUMMARY_MAX);
}

/**
 * Filter delta messages to one game room.
 * @param {{ game: string, platform: string, content: string, at: string }[]} messages
 * @param {string} game
 * @param {string} platform
 */
export function filterDeltaForGame(messages, game, platform) {
  const key = normGameKey(game);
  const plat = platform || "";
  return messages.filter(
    (row) => normGameKey(row.game) === key && (row.platform || "") === plat,
  );
}

/**
 * @param {Array<{ game?: string, platform?: string, messages?: unknown, updated_at?: string }>} chats
 * @param {string | null | undefined} sinceIso
 * @param {string} game
 * @param {string} platform
 */
export function extractGameDeltaFromChats(chats, sinceIso, game, platform) {
  return filterDeltaForGame(extractUserMessagesFromChats(chats, sinceIso), game, platform).slice(
    -MEMORY_DELTA_MESSAGE_CAP,
  );
}

/** @param {{ at?: string }[]} delta */
export function maxDeltaTimestamp(delta) {
  let max = 0;
  for (const row of delta) {
    const parsed = Date.parse(row.at || "");
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  return max > 0 ? new Date(max).toISOString() : null;
}

/** UTC calendar day string (YYYY-MM-DD). */
export function utcTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

/** @param {string} body */
export function journalBodyChars(body) {
  return typeof body === "string" ? body.length : 0;
}

/**
 * @typedef {"auto" | "manual" | "edit"} JournalUpdateTrigger
 * @typedef {{
 *   trigger: JournalUpdateTrigger,
 *   temporary?: boolean,
 *   isRetry?: boolean,
 *   enabled?: boolean,
 *   journalReminder?: string,
 *   row?: {
 *     body?: string,
 *     manual_save_at?: string | null,
 *     last_auto_updated_at?: string | null,
 *     auto_update_day?: string | null,
 *     auto_update_count?: number,
 *     updating_at?: string | null,
 *   } | null,
 *   deltaCount: number,
 *   now?: number,
 * }} JournalGateInput
 */

/** @param {JournalGateInput} input @returns {string | null} */
export function journalUpdateSkipReason(input) {
  const now = input.now ?? Date.now();
  if (input.enabled === false) return "disabled";
  if (input.temporary) return "temporary";
  if (input.isRetry) return "retry";

  if (input.trigger === "edit") {
    if (input.row?.updating_at) {
      const started = Date.parse(input.row.updating_at);
      if (Number.isFinite(started) && now - started < JOURNAL_IN_FLIGHT_STALE_MS) {
        return "in_flight";
      }
    }
    return null;
  }

  if (input.trigger === "auto") {
    if (!input.journalReminder?.trim()) return "no_signal";
    if (input.row?.manual_save_at) {
      const pinned = Date.parse(input.row.manual_save_at);
      if (Number.isFinite(pinned) && now - pinned < JOURNAL_MANUAL_PIN_MS) return "manual_edit_pin";
    }
    if (input.row?.last_auto_updated_at) {
      const last = Date.parse(input.row.last_auto_updated_at);
      if (Number.isFinite(last) && now - last < JOURNAL_DEBOUNCE_MS) return "throttle";
    }
    const today = utcTodayDate();
    const day = input.row?.auto_update_day ?? today;
    const count = day === today ? (input.row?.auto_update_count ?? 0) : 0;
    if (count >= JOURNAL_AUTO_DAILY_CAP) return "daily_cap";
  }

  if (input.row?.updating_at) {
    const started = Date.parse(input.row.updating_at);
    if (Number.isFinite(started) && now - started < JOURNAL_IN_FLIGHT_STALE_MS) {
      return "in_flight";
    }
  }

  const hasBody = Boolean(input.row?.body?.trim());
  const staleOk =
    input.deltaCount > 0 ||
    (input.trigger === "auto" && !hasBody && Boolean(input.journalReminder?.trim()));
  if (!staleOk) return "empty_delta";
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} _userId
 */
export async function enablePlayerJourney(supabase, _userId) {
  const { error } = await supabase.auth.updateUser({
    data: { player_journey_enabled: true },
  });
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function disablePlayerJourney(supabase, userId) {
  const { error: metaError } = await supabase.auth.updateUser({
    data: { player_journey_enabled: false },
  });
  if (metaError) throw metaError;
  const { clearAllPlayerJourneys } = await import("./player-journey-game.js");
  await clearAllPlayerJourneys(supabase, userId);
}
