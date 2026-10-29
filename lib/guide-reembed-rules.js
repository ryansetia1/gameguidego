// Pure rules for the lazy Sumopod -> Qwen re-embed (lib/guide-reembed.ts runs the I/O).

export const REEMBED_BATCH = 25; // same as GUIDE_CHUNK_INSERT_BATCH (statement timeout)
export const REEMBED_BUDGET_MS = 200_000; // whole run, inside the route's 300s kill incl. the answer
export const REEMBED_FLOOR_MS = 30_000; // not worth starting an embed call below this

/**
 * Convert only a Sumopod-tagged guide while Sumopod is down and Qwen is up.
 * @param {{ model: string, sumopodUp: boolean, qwenUp: boolean }} state
 */
export function shouldReembed({ model, sumopodUp, qwenUp }) {
  return model === "sumopod" && !sumopodUp && qwenUp;
}

/**
 * Resumable filter: rows still needing a staged vector (mirrors the SQL filter).
 * @param {{ embedding_next?: unknown }[]} rows
 */
export function pendingRows(rows) {
  return rows.filter((row) => row.embedding_next == null);
}

/**
 * True when a guide's rows carry more than one live embed_model tag.
 * @param {{ embed_model: string }[]} rows
 */
export function hasMixedTags(rows) {
  return new Set(rows.map((row) => row.embed_model)).size > 1;
}

/**
 * Embed timeout for the next batch, or null when under the floor (stop, resume next query).
 * @param {number} startMs
 * @param {number} [now]
 * @returns {number | null}
 */
export function reembedRemainingMs(startMs, now = Date.now()) {
  const left = REEMBED_BUDGET_MS - (now - startMs);
  return left < REEMBED_FLOOR_MS ? null : left;
}
