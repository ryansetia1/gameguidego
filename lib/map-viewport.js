/**
 * Map viewer geometry: fit scale, zoom limits, pan bounds, focal-point zoom and the
 * visible source rect for HD region drawing. Pure math so the canvas viewer stays thin.
 * Conventions: `scale` is relative to fit (1 = whole map fits), `offset` is the map
 * centre's shift from the viewport centre in screen pixels.
 * Plan: docs/plan/vgmaps-map-viewer.md (section 3A.2).
 */

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** @param {number} v */
const positive = (v) => Number.isFinite(v) && v > 0;

/** @param {number} naturalW @param {number} naturalH @param {number} viewportW @param {number} viewportH */
export function calculateFitScale(naturalW, naturalH, viewportW, viewportH) {
  if (!(naturalW > 0 && naturalH > 0 && viewportW > 0 && viewportH > 0)) return 1;
  return Math.min(viewportW / naturalW, viewportH / naturalH);
}

/**
 * Max zoom (relative to fit): enough to go well past 1:1 on huge maps.
 * @param {number} naturalW @param {number} naturalH @param {number} viewportW @param {number} viewportH
 * @param {{ minMaxZoom?: number, nativeMultiplier?: number, maxAllowedZoom?: number }} [opts]
 */
export function calculateMapMaxZoom(
  naturalW,
  naturalH,
  viewportW,
  viewportH,
  { minMaxZoom = 4, nativeMultiplier = 8, maxAllowedZoom = 40 } = {},
) {
  if (!(naturalW > 0 && naturalH > 0 && viewportW > 0 && viewportH > 0)) return minMaxZoom;
  const fit = calculateFitScale(naturalW, naturalH, viewportW, viewportH);
  return clamp((1 / Math.max(fit, 0.01)) * nativeMultiplier, minMaxZoom, maxAllowedZoom);
}

/** @param {number} naturalW @param {number} naturalH @param {number} viewportW @param {number} viewportH @param {number} scale */
export function calculateMapPanBounds(naturalW, naturalH, viewportW, viewportH, scale) {
  if (![naturalW, naturalH, viewportW, viewportH, scale].every(positive)) return { maxPanX: 0, maxPanY: 0 };
  const fit = calculateFitScale(naturalW, naturalH, viewportW, viewportH);
  return {
    maxPanX: Math.max(0, (naturalW * fit * scale - viewportW) / 2),
    maxPanY: Math.max(0, (naturalH * fit * scale - viewportH) / 2),
  };
}

/** @param {{ x: number, y: number }} offset @param {{ maxPanX: number, maxPanY: number }} bounds */
export function clampMapOffset(offset, bounds) {
  return {
    // `+ 0` turns -0 into 0 so a recentred map reads as { x: 0, y: 0 }.
    x: clamp(offset.x, -bounds.maxPanX, bounds.maxPanX) + 0,
    y: clamp(offset.y, -bounds.maxPanY, bounds.maxPanY) + 0,
  };
}

/**
 * Pinch / wheel zoom around `centroid` plus a pan: the map point under the centroid stays
 * under it (until the pan bounds clamp).
 * @param {{ scale: number, offset: { x: number, y: number }, zoomFactor: number,
 *   panDelta?: { x: number, y: number }, centroid: { x: number, y: number },
 *   viewportW: number, viewportH: number, naturalW: number, naturalH: number, maxZoom: number }} input
 * @returns {{ scale: number, offset: { x: number, y: number } }}
 */
export function computeFocalZoomTransform({
  scale,
  offset,
  zoomFactor,
  panDelta = { x: 0, y: 0 },
  centroid,
  viewportW,
  viewportH,
  naturalW,
  naturalH,
  maxZoom,
}) {
  // Bad input (NaN, 0, negative) means "no zoom" rather than a NaN transform.
  const current = positive(scale) ? scale : 1;
  const nextScale = clamp(current * (positive(zoomFactor) ? zoomFactor : 1), 1, Math.max(1, positive(maxZoom) ? maxZoom : 1));
  const factor = 1 - nextScale / current;
  const focalDx = centroid.x - (viewportW / 2 + offset.x);
  const focalDy = centroid.y - (viewportH / 2 + offset.y);
  const next = {
    x: offset.x + panDelta.x + focalDx * factor,
    y: offset.y + panDelta.y + focalDy * factor,
  };
  return {
    scale: nextScale,
    offset: clampMapOffset(next, calculateMapPanBounds(naturalW, naturalH, viewportW, viewportH, nextScale)),
  };
}

/**
 * Overview canvas size: aspect kept, longest side at most `maxDim` (mobile canvas RAM).
 * `overviewScale` is overview pixels per source pixel (1 when the map is already small).
 * @param {number} naturalW @param {number} naturalH @param {number} [maxDim]
 */
export function computeOverviewDimensions(naturalW, naturalH, maxDim = 2048) {
  if (!positive(naturalW) || !positive(naturalH)) return { width: 1, height: 1, overviewScale: 1 };
  const overviewScale = Math.min(1, maxDim / Math.max(naturalW, naturalH, 1));
  return {
    width: Math.max(1, Math.round(naturalW * overviewScale)),
    height: Math.max(1, Math.round(naturalH * overviewScale)),
    overviewScale,
  };
}

/** Screen pixels per source pixel past what the overview holds → draw from the source. */
export function shouldRenderHdOverlay(/** @type {number} */ totalContentScale, /** @type {number} */ overviewScale) {
  return totalContentScale > overviewScale * 1.05;
}

/**
 * The part of the map on screen: source rect (sx, sy, sw, sh) and where it lands
 * (dx, dy, dw, dh), for `drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)`. All zero
 * when nothing is visible.
 * @param {{ naturalW: number, naturalH: number, viewportW: number, viewportH: number,
 *   scale: number, offset: { x: number, y: number } }} input
 */
export function computeVisibleSourceRect({ naturalW, naturalH, viewportW, viewportH, scale, offset }) {
  const total = calculateFitScale(naturalW, naturalH, viewportW, viewportH) * scale;
  const left = viewportW / 2 + offset.x - (naturalW * total) / 2;
  const top = viewportH / 2 + offset.y - (naturalH * total) / 2;
  const dx = Math.max(0, left);
  const dy = Math.max(0, top);
  const dw = Math.max(0, Math.min(viewportW, left + naturalW * total) - dx);
  const dh = Math.max(0, Math.min(viewportH, top + naturalH * total) - dy);
  if (!dw || !dh || !total) return { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: 0, dh: 0 };
  return { sx: (dx - left) / total, sy: (dy - top) / total, sw: dw / total, sh: dh / total, dx, dy, dw, dh };
}
