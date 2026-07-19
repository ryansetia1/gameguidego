// ponytail: window-scroll metrics only; upgrade path = dedicated overflow container + IntersectionObserver sentinel.

/** Within this distance from the bottom we treat the user as "at bottom". */
export const SCROLL_BOTTOM_THRESHOLD_PX = 72;

/** Feed must extend at least this far past the viewport before the FAB can show. */
export const SCROLL_BOTTOM_MIN_OVERFLOW_PX = 96;

/** @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} metrics */
export function distanceFromBottom(metrics) {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) {
    return 0;
  }
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

/** @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} metrics */
export function isNearBottom(metrics, threshold = SCROLL_BOTTOM_THRESHOLD_PX) {
  const t = Number.isFinite(threshold) && threshold >= 0 ? threshold : SCROLL_BOTTOM_THRESHOLD_PX;
  return distanceFromBottom(metrics) <= t;
}

/** @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} metrics */
export function hasScrollableOverflow(metrics, minOverflow = SCROLL_BOTTOM_MIN_OVERFLOW_PX) {
  const min = Number.isFinite(minOverflow) && minOverflow >= 0 ? minOverflow : SCROLL_BOTTOM_MIN_OVERFLOW_PX;
  if (metrics.clientHeight <= 0) return false;
  return metrics.scrollHeight - metrics.clientHeight >= min;
}

/**
 * Show the jump-to-bottom FAB when the thread is long enough and the user has
 * scrolled up past the near-bottom band.
 *
 * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} metrics
 * @param {{ threshold?: number, minOverflow?: number }} [opts]
 */
export function shouldShowScrollToBottomFab(metrics, opts = {}) {
  if (!hasScrollableOverflow(metrics, opts.minOverflow)) return false;
  return !isNearBottom(metrics, opts.threshold);
}

/** @returns {{ scrollTop: number, scrollHeight: number, clientHeight: number }} */
export function windowScrollMetrics() {
  if (typeof window === "undefined") {
    return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  }
  const root = document.documentElement;
  return {
    scrollTop: window.scrollY ?? root.scrollTop,
    scrollHeight: root.scrollHeight,
    clientHeight: window.innerHeight,
  };
}
