/** @typedef {{ role?: string, content?: string }} ProgressTurn */

const POSITION_NOUNS =
  /\b(elevator|elevators|stairs|staircase|basement|ladder|door|room|ledge|switch|warp|hallway|corridor|tangga)\b/gi;

const DIRECTION_WORDS =
  /\b(north|south|east|west|up|down|left|right|utara|selatan|timur|barat|naik|turun)\b/gi;

const MOVEMENT_PHRASE =
  /\b(?:go|climb|descend|head|continue|walk|enter|exit|unlock|ride|carry|pick up|turun|naik|pergi|masuk|keluar)\s+(?:the\s+)?(?:(?:\w+'?s?\s+){0,2})?(?:north|south|east|west|up|down|stairs|staircase|elevator|basement|tangga|barat|timur|utara|selatan)\b/gi;

const HISTORY_ACQUIRE_PATTERNS = [
  /\b(?:got|obtained|acquired|received|mendapatkan|mendapat|dapetin|dapet|dapat(?:kan)?)\s+(?:the\s+)?([a-z0-9][\w'\s-]{2,40}?)(?:\s*[.!?,]|\s+dari\b|\s+from\b|\s+di\b|\s+in\b|\s+untuk\b|$)/gi,
  /\bopen\s+(?:it|the chest)\s+to\s+get\s+(?:the\s+)?([a-z0-9][\w'\s-]{2,40}?)(?:\s*[.!,]|$)/gi,
  /\b(?:baru|just)\s+(?:aja\s+)?(?:buka\s+peti\s+(?:untuk\s+)?(?:dapetin\s+)?|dapetin|dapat(?:kan)?)\s+(?:the\s+)?([a-z0-9][\w'\s-]{2,40}?)(?:\s*[.!,]|$)/gi,
];

const VAGUE_FOLLOWUP =
  /\b(?:setelah\s+(?:itu|ini)|trus|lalu|kemana(?:\s+lagi)?|then\s+what|what(?:'s|\s+is)\s+next|after\s+that|where\s+(?:to|should)|langkah\s+selanjutnya|udah\s+.+\s+setelah\s+itu)\b/i;

// Somewhere the player is standing, not something they finished. "boss" used to be
// here, which made every "I beat the boss, what now?" a position follow-up and cut
// summarize down to a single excerpt — fatal when that one excerpt is wrong.
const POSITION_FOLLOWUP =
  /\b(?:after|setelah|once|already|udah)\b.+\b(?:elevator|stairs|staircase|basement|room|door|tangga)\b/i;

const CHUNK_OPENING_ACQUIRE =
  /\b(open (?:it|the chest)|get the|receive the|obtain the|grab the|take the|open the chest to get)\b/i;

/** Immediate next-step cue at chunk start (not a new area arc). */
const CHUNK_CONTINUATION_OPENING =
  /^(?:in this room|now,|with that done|next,|then,|here,|after that,|from here,|when you|once you)/i;

const TAIL_WINDOW_CHARS = 280;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractPositionLandmarks(text) {
  const lower = (text ?? "").toLowerCase();
  const tokens = new Set();
  for (const match of lower.matchAll(POSITION_NOUNS)) tokens.add(match[0]);
  for (const match of lower.matchAll(DIRECTION_WORDS)) tokens.add(match[0]);
  for (const match of lower.matchAll(MOVEMENT_PHRASE)) tokens.add(match[0].trim());
  return [...tokens];
}

/**
 * @param {string} body
 * @param {string[]} landmarks
 * @returns {number}
 */
export function tailLandmarkHits(body, landmarks) {
  if (!landmarks.length) return 0;
  const tail = (body ?? "").slice(-TAIL_WINDOW_CHARS).toLowerCase();
  let hits = 0;
  for (const landmark of landmarks) {
    if (landmark && tail.includes(landmark.toLowerCase())) hits += 1;
  }
  return hits;
}

/**
 * @param {string} body
 * @param {string[]} landmarks
 * @returns {boolean}
 */
export function tailMatchesLandmarks(body, landmarks) {
  return tailLandmarkHits(body, landmarks) >= 2;
}

/**
 * Chunk tail matches the player's stated position and ends there (answer likely in next chunk).
 *
 * @param {string} body
 * @param {string[]} landmarks
 * @returns {boolean}
 */
export function isTailEndpointChunk(body, landmarks) {
  if (!tailMatchesLandmarks(body, landmarks)) return false;
  const tail = (body ?? "").slice(-TAIL_WINDOW_CHARS).trim();
  return /\b(?:reach the next room|to the next room|up the stairs|climb the stairs|enter (?:that|the) room)\s*[.!?"']*\s*$/i.test(
    tail,
  );
}

/**
 * @param {string} question
 * @returns {boolean}
 */
export function isVagueProgressFollowUp(question) {
  const q = (question ?? "").trim();
  if (!q || q.length > 120) return false;
  return VAGUE_FOLLOWUP.test(q);
}

/**
 * @param {string} question
 * @param {string} [searchTopic]
 * @returns {boolean}
 */
export function isProgressFollowUp(question, searchTopic = "") {
  const text = `${question ?? ""} ${searchTopic ?? ""}`.trim();
  return isVagueProgressFollowUp(question) || POSITION_FOLLOWUP.test(text);
}

/**
 * Follow-up names a concrete position (elevator, stairs, etc.), not just "what's next".
 *
 * @param {string} question
 * @param {string} [searchTopic]
 * @returns {boolean}
 */
export function isPositionProgressFollowUp(question, searchTopic = "") {
  return POSITION_FOLLOWUP.test(`${question ?? ""} ${searchTopic ?? ""}`.trim());
}

/**
 * @param {string} body
 * @returns {boolean}
 */
export function hasContinuationOpening(body) {
  return CHUNK_CONTINUATION_OPENING.test((body ?? "").slice(0, 140).trim());
}

/**
 * Best chunk whose tail is the player's stated endpoint (single neighbor source).
 *
 * @param {{ chunk_text?: string, similarity?: number }[]} rows
 * @param {string[]} landmarks
 * @returns {{ chunk_text?: string, similarity?: number, chunk_index?: number, guide_url?: string } | null}
 */
export function pickBestTailEndpointChunk(rows, landmarks) {
  let best = null;
  let bestScore = -1;
  for (const row of rows) {
    const body = row.chunk_text ?? "";
    if (!isTailEndpointChunk(body, landmarks)) continue;
    const hits = tailLandmarkHits(body, landmarks);
    const score = hits * 10 + (Number(row.similarity) || 0);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Mark chunk_index+1 in an existing pool when it is already present from cosine recall.
 *
 * @param {Array<{ guide_url?: string, chunk_text?: string, chunk_index?: number, neighbor_of_tail?: boolean }>} rows
 * @param {string[]} landmarks
 * @returns {{ rows: any[], parent: any | null, marked: boolean }}
 */
export function markTailNeighborInPool(rows, landmarks) {
  const parent = pickBestTailEndpointChunk(rows, landmarks);
  if (!parent?.guide_url || parent.chunk_index == null) {
    return { rows, parent: null, marked: false };
  }
  const nextIndex = parent.chunk_index + 1;
  let marked = false;
  const updated = rows.map((row) => {
    if (row.guide_url !== parent.guide_url || row.chunk_index !== nextIndex) return row;
    if (!hasContinuationOpening(row.chunk_text ?? "")) return row;
    marked = true;
    return { ...row, neighbor_of_tail: true };
  });
  return { rows: updated, parent, marked };
}

/**
 * @param {string} raw
 * @returns {string}
 */
function cleanOwnedItem(raw) {
  return (raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/[?!.,:;]+$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Items the player already obtained according to chat history (game-agnostic).
 *
 * @param {ProgressTurn[]} [history]
 * @returns {string[]}
 */
export function extractOwnedItemsFromHistory(history) {
  const items = new Set();
  const turns = Array.isArray(history) ? history : [];
  for (const turn of turns) {
    const text = turn?.content ?? "";
    for (const pattern of HISTORY_ACQUIRE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const item = cleanOwnedItem(match[1]);
        if (item.length >= 3 && item.length <= 48) items.add(item);
      }
    }
  }
  return [...items];
}

/**
 * @param {string} body
 * @param {string[]} ownedItems
 * @returns {boolean}
 */
export function chunkOpeningAcquiresOwnedItem(body, ownedItems) {
  if (!ownedItems.length) return false;
  const opening = (body ?? "").slice(0, 450).toLowerCase();
  if (!CHUNK_OPENING_ACQUIRE.test(opening)) return false;
  const openingTokens = opening.replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
  for (const item of ownedItems) {
    const itemTokens = item.split(/\s+/).filter((token) => token.length > 2);
    if (!itemTokens.length) continue;
    let hits = 0;
    for (const token of itemTokens) {
      if (opening.includes(token)) hits += 1;
    }
    if (hits / itemTokens.length >= 0.6) return true;
  }
  return false;
}

/**
 * Position follow-ups: keep only the top-ranked preferred excerpt for summarize.
 * Extra chunks often describe earlier arcs (e.g. Hinox) and cause answer drift.
 *
 * @template {object & { preferred?: boolean }} T
 * @param {T[]} sources
 * @param {string} question
 * @param {string} [searchTopic]
 * @returns {T[]}
 */
export function limitSourcesForPositionFollowUp(sources, question, searchTopic = "") {
  if (!Array.isArray(sources) || !isPositionProgressFollowUp(question, searchTopic)) {
    return sources;
  }
  let keptFirstPreferred = false;
  return sources.filter((source) => {
    if (!source?.preferred) return true;
    if (!keptFirstPreferred) {
      keptFirstPreferred = true;
      return true;
    }
    return false;
  });
}
