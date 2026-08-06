import {
  chunkOpeningAcquiresOwnedItem,
  extractOwnedItemsFromHistory,
  extractPositionLandmarks,
  hasContinuationOpening,
  isPositionProgressFollowUp,
  isProgressFollowUp,
  isTailEndpointChunk,
  tailLandmarkHits,
} from "./guide-progress.js";

/** @typedef {{ chunk_text?: string, similarity?: number, retrieval_score?: number, lexical_rank?: number, chunk_index?: number, section_path?: string[], section_confidence?: number | null, rescore_delta?: number, rescore_reasons?: string[], rescore_score?: number, neighbor_of_tail?: boolean }} RescoreChunk */
/** @typedef {{ role?: string, content?: string }} RescoreHistoryTurn */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "will", "would", "could", "should", "may", "might", "must", "shall", "can",
  "i", "you", "he", "she", "it", "we", "they", "this", "that", "these", "those", "my",
  "your", "from", "into", "where", "what", "when", "how", "please", "provide", "next",
  "after", "getting", "currently", "inside", "should", "go", "am", "me", "please",
  "directions", "objective", "area", "proceed", "item", "acquired", "just",
]);

const QUERY_EARLY_HINTS =
  /\b(just|baru|currently|inside|acquired|picked up|opened the chest|got the|got|dapetin|baru aja|masih di|obtaining|acquiring|obtained|immediately after|progress through the dungeon|within the dungeon|inside the dungeon|following the steps|what are the next steps|setelah dapet|setelah dapat|setelah mendapat)\b/i;

/** Player already has the focal item; asking what to do next (common follow-up rewrite). */
const QUERY_ALREADY_HAVE =
  /\b(obtaining|obtained|acquiring|acquired|after getting|after obtaining|immediately after|setelah (?:dapet|dapat|mendapat))\b/i;

const CHUNK_FORWARD_HINTS =
  /\b(after you (?:leave|are brought)|outside of|return to|brought back outside|once it'?s over|defeated the final|completed the|heart container|overworld)\b/i;

const CHUNK_CONTINUATION_HINTS =
  /\b(next,?\s+(?:go|back)|then,?\s+go|continue (?:east|west|north|south|to|into)|use (?:it|the key)|unlock the|open the (?:door|locked|southern))\b/i;

/** Acquire sentence immediately followed by a next-step cue (same chunk). */
const CHUNK_POST_ACQUIRE_CONTINUATION =
  /\b(?:get|receive|obtain|open)\s+(?:the\s+)?[\w\s]{0,28}?\b(key|item)\b[^.!?]{0,48}[.!?\n]\s*next,/i;

const QUERY_LATE_HINTS =
  /\b(after (?:beating|defeating)|once (?:i'?ve|you'?ve) (?:beat|defeated|finished|completed)|post[- ]?game|endgame)\b/i;

const ACQUIRE_VERBS =
  /\b(open (?:it|the chest)|get the|receive the|obtain the|grab the|take the|acquired|picked up)\b/i;

const NOW_THAT_HAVE =
  /\bnow that you have (?:the\s+)?([^.!?\n,]{3,50})/i;

const FOCAL_ITEM_PATTERNS = [
  /\bafter obtaining\s+(?:the\s+)?([a-z0-9][\w\s'-]{2,48}?)(?:\?|[.,]|\s+specifically|\s+please|\s+where|\s+what|$)/i,
  /\b(?:has\s+)?already\s+(?:obtained|acquired)\s+(?:the\s+)?([a-z0-9][\w\s'-]{2,48}?)(?:\s+and|\s+from|\s+in|\s+inside|\s*,|\s+following|\s+what|\s+please|\?|$)/i,
  /\b(?:obtaining|acquiring|obtained|acquired)\s+(?:the\s+)?([a-z0-9][\w\s'-]{2,48}?)(?:\s+and|\s+from|\s+in|\s+inside|\s*,|\s+following|\s+what|\s+please|\?|$)/i,
  /\b(?:getting|got|receive|received|obtain|picked up|open(?:ed)?(?:\s+the)?\s+chest(?:\s+(?:for|to get))?)\s+(?:the\s+)?([a-z0-9][\w\s'-]{2,48}?)(?:\s+from|\s+in|\s+inside|\s*,|\s+after|\s+where|\s+and|\s+setelah|$)/i,
  /\b(?:baru|just)\s+(?:aja\s+)?(?:buka|dapetin|dapat|dapatkan)\s+(?:peti\s+)?(?:untuk\s+)?(?:dapetin\s+)?([a-z0-9][\w\s'-]{2,48}?)(?:\s*,|\s+setelah|$)/i,
  /\bsetelah\s+(?:dapet|dapat|mendapat)(?:kan)?\s+(?:the\s+)?([a-z0-9][\w\s'-]{2,32}?)(?:\s+|$)/i,
];

const TIER_PATTERN =
  /\b(level\s*\d+|lv\.?\s*\d+|\+\d+|mk\.?\s*ii|advanced|improved|upgraded|enhanced|super)\b/i;

/**
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function overlapRatio(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const token of a) if (setB.has(token)) hits += 1;
  return hits / Math.max(a.length, 1);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasTierMarker(text) {
  return TIER_PATTERN.test(text ?? "");
}

/**
 * @param {string} queryText
 * @returns {string}
 */
export function extractQueryFocalItem(queryText) {
  for (const pattern of FOCAL_ITEM_PATTERNS) {
    const match = (queryText ?? "").match(pattern);
    if (match?.[1]) {
      return match[1]
        .replace(/\s+/g, " ")
        .replace(/[?!.,:;]+$/g, "")
        .trim()
        .toLowerCase();
    }
  }
  return "";
}

/**
 * @param {string} body
 * @returns {string}
 */
function extractChunkPrerequisite(body) {
  const match = (body ?? "").slice(0, 400).match(NOW_THAT_HAVE);
  if (!match?.[1]) return "";
  return match[1].replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function phraseOverlap(a, b) {
  if (!a || !b) return 0;
  return overlapRatio(tokenize(a), tokenize(b));
}

/**
 * @param {string} body
 * @param {string[]} focalTokens
 * @returns {boolean}
 */
function hasNearbyAcquisition(body, focalTokens) {
  const windows = (body ?? "")
    .split(/[.!?\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 10);
  for (const window of windows) {
    const lower = window.toLowerCase();
    if (!ACQUIRE_VERBS.test(lower)) continue;
    if (!focalTokens.length || overlapRatio(focalTokens, tokenize(window)) > 0.15) return true;
  }
  return false;
}

/**
 * Chunk still describes obtaining the focal item, not using it / moving on.
 *
 * @param {string} body
 * @param {string[]} focalTokens
 * @returns {boolean}
 */
function isChunkPriorAcquisitionMoment(body, focalTokens) {
  if (CHUNK_POST_ACQUIRE_CONTINUATION.test(body)) return false;
  const opening = (body ?? "").slice(0, 450);
  const windows = opening.split(/[.!?\n]+/).map((part) => part.trim()).filter(Boolean);
  for (const window of windows) {
    const lower = window.toLowerCase();
    if (!ACQUIRE_VERBS.test(lower)) continue;
    if (focalTokens.length && overlapRatio(focalTokens, tokenize(window)) < 0.15) continue;
    if (CHUNK_CONTINUATION_HINTS.test(lower)) return false;
    return true;
  }
  return false;
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function hasPostAcquireContinuation(body) {
  if (CHUNK_POST_ACQUIRE_CONTINUATION.test(body ?? "")) return true;
  return CHUNK_CONTINUATION_HINTS.test((body ?? "").slice(0, 500));
}

/**
 * Rules-based rerank for preferred-guide chunks (game-agnostic).
 *
 * @param {{ query?: string, searchTopic?: string, history?: RescoreHistoryTurn[], chunks?: RescoreChunk[] }} input
 * @returns {RescoreChunk[]}
 */
export function rescoreGuideChunks(input) {
  const chunks = Array.isArray(input?.chunks) ? input.chunks : [];
  if (chunks.length <= 1) return chunks;

  const queryText = `${input.query ?? ""} ${input.searchTopic ?? ""}`.trim();
  const queryTokens = tokenize(queryText);
  const queryEarly = QUERY_EARLY_HINTS.test(queryText);
  const queryLate = QUERY_LATE_HINTS.test(queryText);
  const queryHasTier = hasTierMarker(queryText);
  const queryFocalItem = extractQueryFocalItem(queryText);
  const queryFocalTokens = tokenize(queryFocalItem);
  const positionLandmarks = extractPositionLandmarks(queryText);
  const ownedItems = extractOwnedItemsFromHistory(input.history);
  const progressFollowUp = isProgressFollowUp(input.query ?? "", input.searchTopic ?? "");
  const positionProgressFollowUp = isPositionProgressFollowUp(
    input.query ?? "",
    input.searchTopic ?? "",
  );
  const queryPostAcquisition =
    Boolean(queryFocalItem) &&
    !/\b(just acquired|just got|just obtained|baru aja)\b/i.test(queryText) &&
    (QUERY_ALREADY_HAVE.test(queryText) ||
      /\b(?:next steps|what to do immediately|kemana lagi|following the steps|immediately after)\b/i.test(
        queryText,
      ) ||
      /\bsetelah\s+(?:dapet|dapat|mendapat)/i.test(input.query ?? ""));

  const scored = chunks.map((chunk) => {
    const reasons = [];
    let delta = 0;
    const body = chunk.chunk_text ?? "";
    const bodyLower = body.toLowerCase();
    const sectionText = (chunk.section_path ?? []).join(" ");
    const opening = body.slice(0, 220);
    const chunkPrerequisite = extractChunkPrerequisite(body);
    const prerequisiteMismatch =
      queryEarly &&
      queryFocalItem &&
      chunkPrerequisite &&
      phraseOverlap(queryFocalItem, chunkPrerequisite) < 0.35;

    const sectionOverlap = overlapRatio(queryTokens, tokenize(`${sectionText} ${opening}`));
    if (sectionOverlap > 0.15 && !prerequisiteMismatch) {
      delta += Math.min(0.1, sectionOverlap * 0.35);
      reasons.push("section_overlap");
    }

    if (prerequisiteMismatch) {
      delta -= 0.15;
      reasons.push("prerequisite_mismatch");
    }

    // "After defeating the boss, what now?" is forward-looking by definition, so the
    // late pattern outranks the early one. Without this the boilerplate a rewrite adds
    // ("what are the next steps") classified a finished arc as still in progress and
    // penalised the chunk describing the aftermath (trace 14a03ed6).
    if (queryEarly && !queryLate && CHUNK_FORWARD_HINTS.test(bodyLower)) {
      delta -= 0.12;
      reasons.push("forward_jump_penalty");
    } else if (queryLate && !CHUNK_FORWARD_HINTS.test(bodyLower) && ACQUIRE_VERBS.test(bodyLower)) {
      delta -= 0.04;
      reasons.push("early_section_penalty");
    }

    if (queryPostAcquisition && isChunkPriorAcquisitionMoment(body, queryFocalTokens)) {
      delta -= 0.12;
      reasons.push("prior_acquisition_penalty");
    }

    if (
      queryPostAcquisition &&
      !positionProgressFollowUp &&
      hasPostAcquireContinuation(body) &&
      !(ownedItems.length && chunkOpeningAcquiresOwnedItem(body, ownedItems))
    ) {
      delta += 0.12;
      reasons.push("continuation_boost");
    }

    if (
      queryEarly &&
      !queryPostAcquisition &&
      !positionProgressFollowUp &&
      hasNearbyAcquisition(body, queryFocalTokens)
    ) {
      const queryOverlap = overlapRatio(queryTokens, tokenize(body));
      if (queryOverlap > 0.08) {
        delta += 0.12;
        reasons.push("acquisition_anchor");
      }
    }

    // Only the penalty half survives: it keeps an upgraded/tiered variant from
    // answering a question that never asked for one. The matching half used to add
    // +0.05 whenever both sides merely *had* a tier marker, without comparing the
    // number, so a "Level 3" question boosted "Level 7" and "Level 2" chunks to rank
    // 1 and 2 (trace 14a03ed6). Comparing numbers is not worth the code either, since
    // an exact-name lexical hit already carries that signal.
    if (hasTierMarker(body) && !queryHasTier) {
      delta -= 0.1;
      reasons.push("tier_mismatch_penalty");
    }

    const lexical = overlapRatio(queryTokens, tokenize(body));
    if (lexical > 0.12) {
      delta += Math.min(0.05, lexical * 0.2);
      reasons.push("lexical_overlap");
    }

    const tailHits = tailLandmarkHits(body, positionLandmarks);
    const tailEndpoint = isTailEndpointChunk(body, positionLandmarks);
    if (tailHits >= 2) {
      const allowTailBoost =
        !positionProgressFollowUp || tailEndpoint || Boolean(chunk.neighbor_of_tail);
      if (allowTailBoost) {
        delta += Math.min(0.1, tailHits * 0.04);
        reasons.push("tail_position_match");
      }
    }

    if (progressFollowUp && tailEndpoint) {
      delta -= 0.18;
      reasons.push("tail_endpoint_penalty");
    }

    if (chunk.neighbor_of_tail && hasContinuationOpening(body)) {
      delta += 0.16;
      reasons.push("neighbor_continuation_boost");
    }

    if (ownedItems.length && chunkOpeningAcquiresOwnedItem(body, ownedItems)) {
      delta -= 0.14;
      reasons.push("history_owned_acquire_penalty");
    }

    // Rank on the retrieval stage's own score (cosine fused with any exact-name
    // hit), so a hybrid or reranked order survives instead of collapsing back to
    // raw cosine. Falls back to cosine when retrieval supplied nothing else.
    const base = Number(chunk.retrieval_score ?? chunk.similarity) || 0;
    return {
      ...chunk,
      rescore_delta: delta,
      rescore_reasons: reasons,
      rescore_score: base + delta,
    };
  });

  scored.sort((a, b) => (b.rescore_score ?? 0) - (a.rescore_score ?? 0));

  if (positionProgressFollowUp) {
    const neighborIdx = scored.findIndex((row) => row.neighbor_of_tail);
    if (neighborIdx > 0) {
      const [neighbor] = scored.splice(neighborIdx, 1);
      neighbor.rescore_reasons = [...(neighbor.rescore_reasons ?? []), "neighbor_rank_pin"];
      scored.unshift(neighbor);
    }
  }

  return scored;
}
