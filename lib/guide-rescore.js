/** @typedef {{ chunk_text?: string, similarity?: number, chunk_index?: number, section_path?: string[], section_confidence?: number | null, rescore_delta?: number, rescore_reasons?: string[], rescore_score?: number }} RescoreChunk */

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
  /\b(just|baru|currently|inside|acquired|picked up|opened the chest|got the|got|dapetin|baru aja|masih di)\b/i;

const CHUNK_FORWARD_HINTS =
  /\b(after you (?:leave|are brought)|outside of|return to|brought back outside|once it'?s over|defeated the final|completed the|heart container|overworld)\b/i;

const QUERY_LATE_HINTS =
  /\b(after (?:beating|defeating)|once (?:i'?ve|you'?ve) (?:beat|defeated|finished|completed)|post[- ]?game|endgame)\b/i;

const ACQUIRE_VERBS =
  /\b(open (?:it|the chest)|get the|receive the|obtain the|grab the|take the|acquired|picked up)\b/i;

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
 * Rules-based rerank for preferred-guide chunks (game-agnostic).
 *
 * @param {{ query?: string, searchTopic?: string, chunks?: RescoreChunk[] }} input
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

  const scored = chunks.map((chunk) => {
    const reasons = [];
    let delta = 0;
    const body = chunk.chunk_text ?? "";
    const bodyLower = body.toLowerCase();
    const sectionText = (chunk.section_path ?? []).join(" ");
    const opening = body.slice(0, 220);

    const sectionOverlap = overlapRatio(queryTokens, tokenize(`${sectionText} ${opening}`));
    if (sectionOverlap > 0.15) {
      delta += Math.min(0.1, sectionOverlap * 0.35);
      reasons.push("section_overlap");
    }

    if (queryEarly && CHUNK_FORWARD_HINTS.test(bodyLower)) {
      delta -= 0.12;
      reasons.push("forward_jump_penalty");
    } else if (queryLate && !CHUNK_FORWARD_HINTS.test(bodyLower) && ACQUIRE_VERBS.test(bodyLower)) {
      delta -= 0.04;
      reasons.push("early_section_penalty");
    }

    if (queryEarly && ACQUIRE_VERBS.test(bodyLower)) {
      const queryOverlap = overlapRatio(queryTokens, tokenize(body));
      if (queryOverlap > 0.08) {
        delta += 0.12;
        reasons.push("acquisition_anchor");
      }
    }

    const chunkHasTier = hasTierMarker(body);
    if (chunkHasTier && !queryHasTier) {
      delta -= 0.1;
      reasons.push("tier_mismatch_penalty");
    } else if (queryHasTier && chunkHasTier) {
      delta += 0.05;
      reasons.push("tier_match_boost");
    }

    const lexical = overlapRatio(queryTokens, tokenize(body));
    if (lexical > 0.12) {
      delta += Math.min(0.05, lexical * 0.2);
      reasons.push("lexical_overlap");
    }

    const base = Number(chunk.similarity) || 0;
    return {
      ...chunk,
      rescore_delta: delta,
      rescore_reasons: reasons,
      rescore_score: base + delta,
    };
  });

  scored.sort((a, b) => (b.rescore_score ?? 0) - (a.rescore_score ?? 0));
  return scored;
}
