import { journalUpdateToast } from "@/lib/journal-hints.js";

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;

/**
 * Read last journal update time for poll baseline (ms since epoch, 0 when unset).
 * @param {{ access_token: string }} session
 * @param {{ game: string, platform?: string, catalogGameId?: number | null }} input
 */
export async function fetchJournalLastUpdatedMs(session, input) {
  const params = new URLSearchParams({
    game: input.game,
    platform: input.platform || "",
    light: "1",
  });
  if (input.catalogGameId != null && Number.isFinite(input.catalogGameId)) {
    params.set("catalogGameId", String(Math.floor(input.catalogGameId)));
  }
  const response = await fetch(`/api/player-journey?${params}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!response.ok) return 0;
  const payload = await response.json();
  const iso = typeof payload.lastUpdatedAt === "string" ? payload.lastUpdatedAt : "";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Poll until journal lastUpdatedAt advances past baseline (nested after() may finish after SSE closes).
 * ponytail: fixed 15×2s poll; upgrade path is long-lived SSE or push subscription.
 * @param {{ access_token: string }} session
 * @param {{ game: string, platform?: string, catalogGameId?: number | null, sinceMs: number, signal?: AbortSignal }} input
 * @returns {Promise<{ summary: string, trigger: string, bodyChars: number } | null>}
 */
export async function pollJournalUpdateAfterTurn(session, input) {
  const params = new URLSearchParams({
    game: input.game,
    platform: input.platform || "",
    light: "1",
  });
  if (input.catalogGameId != null && Number.isFinite(input.catalogGameId)) {
    params.set("catalogGameId", String(Math.floor(input.catalogGameId)));
  }

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    if (input.signal?.aborted) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (input.signal?.aborted) return null;

    const response = await fetch(`/api/player-journey?${params}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
      signal: input.signal,
    });
    if (!response.ok) continue;
    const payload = await response.json();
    const iso = typeof payload.lastUpdatedAt === "string" ? payload.lastUpdatedAt : "";
    const updatedMs = Date.parse(iso);
    if (!Number.isFinite(updatedMs) || updatedMs <= input.sinceMs) continue;

    const bodyChars = typeof payload.bodyChars === "number" ? payload.bodyChars : 0;
    const summary =
      typeof payload.lastToastSummary === "string" && payload.lastToastSummary.trim()
        ? payload.lastToastSummary.trim()
        : journalUpdateToast({
            trigger: "auto",
            bodyCharsBefore: input.sinceMs > 0 ? 1 : 0,
          });
    return {
      summary,
      trigger: "auto",
      bodyChars,
    };
  }
  return null;
}
