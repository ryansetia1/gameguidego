/**
 * Remembered reading position per saved item (#18), device-only:
 * localStorage `gg:reading-pos` = { [itemId]: { section, offset } } where `section` is the
 * index of the heading above the viewport top (-1 = before the first heading) and `offset`
 * is px scrolled past it. Same try/catch pattern as spoiler-prefs: storage problems mean
 * "start at the top", never an error.
 */

export const READING_POS_KEY = "gg:reading-pos";
const MAX_ENTRIES = 200;

/** @returns {Record<string, { section: number, offset: number, at?: number }>} */
function readAll() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(READING_POS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, { section: number, offset: number, at?: number }>} all */
function writeAll(all) {
  try {
    window.localStorage.setItem(READING_POS_KEY, JSON.stringify(all));
  } catch {
    // quota / private mode: positions just aren't remembered.
  }
}

/** @param {string} id @returns {{ section: number, offset: number } | null} */
export function loadReadingPos(id) {
  if (typeof window === "undefined") return null;
  const pos = readAll()[id];
  if (!pos || !Number.isFinite(pos.section) || !Number.isFinite(pos.offset)) return null;
  return { section: pos.section, offset: Math.max(0, pos.offset) };
}

/** @param {string} id @param {{ section: number, offset: number }} pos */
export function saveReadingPos(id, pos) {
  if (typeof window === "undefined") return;
  const all = readAll();
  all[id] = { section: pos.section, offset: Math.round(pos.offset), at: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0))
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((old) => delete all[old]);
  }
  writeAll(all);
}

/** @param {string} id */
export function clearReadingPos(id) {
  if (typeof window === "undefined") return;
  const all = readAll();
  if (!(id in all)) return;
  delete all[id];
  writeAll(all);
}

/**
 * Turn a scrollTop into { section, offset } given each heading's top (px from the scroller top).
 * @param {number} scrollTop @param {number[]} headingTops ascending
 */
export function positionFromScroll(scrollTop, headingTops) {
  let section = -1;
  for (let i = 0; i < headingTops.length; i++) {
    if (headingTops[i] <= scrollTop) section = i;
    else break;
  }
  const base = section >= 0 ? headingTops[section] : 0;
  return { section, offset: Math.max(0, scrollTop - base) };
}

/**
 * Inverse of positionFromScroll. Returns null (start at top) when the section no longer exists,
 * e.g. the content changed since the position was saved.
 * @param {{ section: number, offset: number }} pos @param {number[]} headingTops
 */
export function scrollFromPosition(pos, headingTops) {
  if (pos.section >= headingTops.length) return null;
  const base = pos.section >= 0 ? headingTops[pos.section] : 0;
  return base + pos.offset;
}
