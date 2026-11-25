/**
 * Shared back-press helpers (#59), pure/tiny so they are testable.
 *
 * 1. Layers that own no history entry (the composer "+" menu) register a closer here.
 *    A back press that finds one closes it and restores the entry it popped, so one
 *    press closes exactly one layer. Same pattern for any future layer of that kind.
 * 2. `nextWouldReload`: Next's app router hard-reloads on popstate when the landing
 *    entry has no `__NA` marker. App entries pushed before its history patch lack it.
 */

/** @type {(() => void) | null} */
let closer = null;

/** @param {(() => void) | null} fn registers (or clears, with null) the open layer's closer */
export function setBackLayer(fn) {
  closer = fn;
}

export function hasBackLayer() {
  return closer !== null;
}

/** Close the registered layer, if any. Returns whether one was closed. */
export function closeBackLayer() {
  const fn = closer;
  closer = null;
  if (!fn) return false;
  fn();
  return true;
}

/** @param {{ gggDepth?: number, __NA?: boolean } | null | undefined} state */
export function nextWouldReload(state) {
  return !!state && typeof state.gggDepth === "number" && !state.__NA;
}

/**
 * A popstate that went back (not forward) while a history-less layer is open.
 * @param {{ hasLayer: boolean, depth: number, prevDepth: number }} a
 */
export function shouldSwallowBack({ hasLayer, depth, prevDepth }) {
  return hasLayer && depth < prevDepth;
}
