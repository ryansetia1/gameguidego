// Pure rules for the lazy Sumopod -> Qwen re-embed (lib/guide-reembed.ts runs the I/O).

export const REEMBED_BATCH = 16; // = QWEN_BATCH, so one loop is exactly one Qwen prediction
export const REEMBED_BUDGET_MS = 200_000; // own cap; also bounded by the request's 300s kill below
export const REQUEST_HARD_KILL_MS = 300_000; // route maxDuration
export const REEMBED_MARGIN_MS = 45_000; // room for the flip and bookkeeping
export const REEMBED_FLOOR_MS = 30_000; // not worth starting an embed call below this

/**
 * Convert only a Sumopod-tagged guide while Sumopod is down and Qwen is up.
 * @param {{ model: string, sumopodUp: boolean, qwenUp: boolean }} state
 */
export function shouldReembed({ model, sumopodUp, qwenUp }) {
  return model === "sumopod" && !sumopodUp && qwenUp;
}

/**
 * Embed budget left, or null when under the floor (stop, resume next query). Anchored to the
 * REQUEST start (after() runs once the answer is done, inside the same 300s kill).
 * @param {number} startMs when this run started
 * @param {number} [now]
 * @param {number} [requestStartMs] when the originating request started
 * @returns {number | null}
 */
export function reembedRemainingMs(startMs, now = Date.now(), requestStartMs = startMs) {
  const left = Math.min(
    REEMBED_BUDGET_MS - (now - startMs),
    REQUEST_HARD_KILL_MS - (now - requestStartMs) - REEMBED_MARGIN_MS,
  );
  return left < REEMBED_FLOOR_MS ? null : left;
}
