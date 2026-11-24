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

/**
 * Visible source + destination rect on a full-bleed canvas that sits behind persistent HUD
 * bars. Fit scale and pan bounds are computed against the unobstructed `(visibleW, visibleH)`
 * area starting at `(insetLeft, insetTop)` so map edges can always reach the visible area,
 * while the map still renders underneath the bars across `[0, canvasW] × [0, canvasH]`.
 * @param {{ naturalW: number, naturalH: number, canvasW: number, canvasH: number,
 *   visibleW: number, visibleH: number, insetLeft?: number, insetTop?: number,
 *   scale: number, offset: { x: number, y: number } }} input
 */
export function computeCanvasDrawRect({
  naturalW,
  naturalH,
  canvasW,
  canvasH,
  visibleW,
  visibleH,
  insetLeft = 0,
  insetTop = 0,
  scale,
  offset,
}) {
  if (![naturalW, naturalH, canvasW, canvasH, visibleW, visibleH, scale].every(positive)) {
    return { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: 0, dh: 0 };
  }
  const total = calculateFitScale(naturalW, naturalH, visibleW, visibleH) * scale;
  const centerX = insetLeft + visibleW / 2 + offset.x;
  const centerY = insetTop + visibleH / 2 + offset.y;
  const left = centerX - (naturalW * total) / 2;
  const top = centerY - (naturalH * total) / 2;
  const dx = Math.max(0, left);
  const dy = Math.max(0, top);
  const dw = Math.max(0, Math.min(canvasW, left + naturalW * total) - dx);
  const dh = Math.max(0, Math.min(canvasH, top + naturalH * total) - dy);
  if (!dw || !dh || !total) return { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: 0, dh: 0 };
  const sx = clamp((dx - left) / total, 0, naturalW);
  const sy = clamp((dy - top) / total, 0, naturalH);
  const sw = clamp(dw / total, 0, naturalW - sx);
  const sh = clamp(dh / total, 0, naturalH - sy);
  return { sx, sy, sw, sh, dx, dy, dw, dh };
}

/**
 * Bounded drag with subtle asymptotic resistance up to `maxOverscroll` px past the edge.
 * Under `reducedMotion` (or `maxOverscroll <= 0`) hard-clamps with no rubber-band.
 * @param {number} value @param {number} maxBound @param {number} [maxOverscroll] @param {boolean} [reducedMotion]
 */
export function applyOverscrollResistance(value, maxBound, maxOverscroll = 24, reducedMotion = false) {
  const limit = Number.isFinite(maxBound) && maxBound > 0 ? maxBound : 0;
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) <= limit) return value + 0;
  if (reducedMotion || !(maxOverscroll > 0)) return clamp(value, -limit, limit) + 0;
  const sign = value < 0 ? -1 : 1;
  const excess = Math.abs(value) - limit;
  const damped = maxOverscroll * (1 - Math.exp(-excess / (maxOverscroll * 2)));
  return sign * (limit + damped);
}

/**
 * Scale (relative to fit) that renders the map at 1:1 native pixels, clamped to `[1, maxZoom]`.
 * @param {number} naturalW @param {number} naturalH @param {number} visibleW @param {number} visibleH @param {number} maxZoom
 */
export function actualSizeScale(naturalW, naturalH, visibleW, visibleH, maxZoom) {
  const fit = calculateFitScale(naturalW, naturalH, visibleW, visibleH);
  const max = Math.max(1, positive(maxZoom) ? maxZoom : 1);
  return clamp(1 / Math.max(fit, 1e-4), 1, max);
}

/**
 * Double-tap / double-click toggle target: zoomed in → Fit (1); at Fit → 1:1 native pixels
 * (or 2.5x when the map is already smaller than the viewport so Fit >= 1:1).
 * @param {number} scale @param {number} naturalW @param {number} naturalH
 * @param {number} visibleW @param {number} visibleH @param {number} maxZoom
 */
export function doubleTapTargetScale(scale, naturalW, naturalH, visibleW, visibleH, maxZoom) {
  if (scale > 1.05) return 1;
  const max = Math.max(1, positive(maxZoom) ? maxZoom : 1);
  const native = 1 / Math.max(calculateFitScale(naturalW, naturalH, visibleW, visibleH), 1e-4);
  return clamp(native > 1.05 ? native : 2.5, 1, max);
}

/**
 * Whole-percent zoom readout where 100% is 1:1 actual pixel size (`fitScale * scale === 1`).
 * @param {number} fitScale @param {number} scale
 */
export function formatZoomPercent(fitScale, scale) {
  if (!positive(fitScale) || !positive(scale)) return 100;
  return Math.max(1, Math.round(fitScale * scale * 100));
}

/**
 * Zoom multiplier for one wheel / trackpad-pinch event (~10% per mouse wheel notch).
 * @param {number} deltaY @param {number} [deltaMode] @param {boolean} [ctrlKey]
 */
export function wheelZoomFactor(deltaY, deltaMode = 0, ctrlKey = false) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  if (deltaMode !== 0 || (!ctrlKey && Math.abs(deltaY) >= 50)) {
    return deltaY < 0 ? 1.1 : 1 / 1.1;
  }
  return clamp(Math.exp(-deltaY * (ctrlKey ? 0.01 : 0.002)), 0.75, 1.35);
}

/**
 * Clamp a saved map's restored viewport to the current visible bounds and zoom range.
 * @param {{ lastZoom?: number, lastOffsetX?: number, lastOffsetY?: number,
 *   naturalW: number, naturalH: number, visibleW: number, visibleH: number, maxZoom: number }} input
 * @returns {{ scale: number, offset: { x: number, y: number } }}
 */
export function clampRestoredViewport({
  lastZoom,
  lastOffsetX,
  lastOffsetY,
  naturalW,
  naturalH,
  visibleW,
  visibleH,
  maxZoom,
}) {
  const max = Math.max(1, positive(maxZoom) ? maxZoom : 1);
  const scale = typeof lastZoom === "number" && Number.isFinite(lastZoom) ? clamp(lastZoom, 1, max) : 1;
  const rawOffset = {
    x: typeof lastOffsetX === "number" && Number.isFinite(lastOffsetX) ? lastOffsetX : 0,
    y: typeof lastOffsetY === "number" && Number.isFinite(lastOffsetY) ? lastOffsetY : 0,
  };
  return {
    scale,
    offset: clampMapOffset(rawOffset, calculateMapPanBounds(naturalW, naturalH, visibleW, visibleH, scale)),
  };
}

/** Format byte count as megabytes with one decimal place (e.g. `3.1`). @param {number} bytes */
export function formatMegabytes(bytes) {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return (safe / (1024 * 1024)).toFixed(1);
}

/** Format pixel dimensions with `×` (falls back to normalizing a `W x H` string). @param {number|null|undefined} width @param {number|null|undefined} height @param {string} [fallback] */
export function formatDimensionsLabel(width, height, fallback = "") {
  if (positive(/** @type {number} */ (width)) && positive(/** @type {number} */ (height))) {
    return `${Math.round(/** @type {number} */ (width))} × ${Math.round(/** @type {number} */ (height))}`;
  }
  const trimmed = String(fallback || "").trim();
  return trimmed ? trimmed.replace(/\s*[x×]\s*/i, " × ") : "";
}

/** User-facing toast copy for a `saveMap` result inside the viewer top layer. @param {string} status */
export function mapSaveToastMessage(status) {
  if (status === "quota") return "Not enough space on this device. Remove a saved map and try again.";
  if (status === "cap") return "Saved maps are full. Remove one to add more.";
  if (status === "too_large") return "This map is too large to open here (over 30 MB).";
  if (status === "error" || status === "unlisted") return "Couldn't save. Check your connection.";
  return null;
}
