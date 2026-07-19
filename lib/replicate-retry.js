/**
 * Retry helper for Replicate rate limits / low-balance throttling.
 * ponytail: string-matching on error messages; upgrade path is parsing Replicate
 * structured error codes when the SDK exposes them reliably.
 */

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isReplicateRateLimit(error) {
  if (!error) return false;
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(/** @type {{ status?: unknown }} */ (error).status)
      : NaN;
  if (status === 429) return true;

  const msg = String(
    error instanceof Error ? error.message : error,
  ).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("throttl") ||
    msg.includes("too many requests") ||
    msg.includes("concurrent") ||
    msg.includes("try again later")
  );
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number; baseMs?: number; signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
export async function withReplicateRetry(fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseMs = options.baseMs ?? 2_000;
  const { signal } = options;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (!isReplicateRateLimit(error) || attempt === maxAttempts - 1) throw error;
      const wait = baseMs * 2 ** attempt + Math.floor(Math.random() * 400);
      console.warn(
        `Replicate rate limited; retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`,
      );
      await sleep(wait, signal);
    }
  }

  throw lastError;
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {number} max
 */
export function parsePositiveInt(raw, fallback, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}
