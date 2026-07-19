// ponytail: ~4 chars/token heuristic; good enough for chunk sizing, not billing.
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = 500 * CHARS_PER_TOKEN;
const OVERLAP_CHARS = Math.floor(TARGET_CHARS * 0.15);
const MIN_CHUNK_CHARS = 40;

const MD_HEADING = /^(#{1,3}\s+.+)$/m;
const RULE_LINE = /^[=\-]{3,}\s*$/m;
const NUMBERED_SECTION = /^\d+\.\s+[A-Z]/m;

/**
 * Split guide text into atomic units (sections / paragraphs). Never splits
 * mid-paragraph; oversized units are returned whole for downstream splitting.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoUnits(text) {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return [];

  let parts;
  if (MD_HEADING.test(trimmed)) {
    parts = trimmed.split(/(?=^#{1,3}\s+)/m);
  } else if (RULE_LINE.test(trimmed)) {
    parts = trimmed.split(/\n[=\-]{3,}\s*\n/);
  } else if (NUMBERED_SECTION.test(trimmed)) {
    parts = trimmed.split(/(?=^\d+\.\s+[A-Z])/m);
  } else {
    parts = trimmed.split(/\n{2,}/);
  }

  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Split an oversized unit by blank-line paragraphs, then by sentences.
 *
 * @param {string} unit
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitOversized(unit, maxChars) {
  if (unit.length <= maxChars) return [unit];

  const paragraphs = unit.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) {
    const out = [];
    for (const para of paragraphs) {
      out.push(...splitOversized(para, maxChars));
    }
    return out;
  }

  const sentences = unit.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [unit];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    const next = current ? `${current} ${piece}` : piece;
    if (next.length > maxChars && current) {
      chunks.push(current.trim());
      current = piece;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [unit.slice(0, maxChars)];
}

/**
 * Structure-aware chunking for guide pages: headings / rules / paragraphs,
 * packed to ~500 tokens with ~15% overlap between consecutive chunks.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function chunkGuide(text) {
  const units = splitIntoUnits(typeof text === "string" ? text : "");
  if (!units.length) return [];

  /** @type {string[]} */
  const chunks = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length >= MIN_CHUNK_CHARS) chunks.push(trimmed);
    current = "";
  };

  for (const unit of units) {
    // Major headings start a new chunk so retrieval returns whole sections.
    if (/^#{1,3}\s/.test(unit) && current.trim()) {
      flush();
    }

    if (unit.length > TARGET_CHARS) {
      flush();
      for (const part of splitOversized(unit, TARGET_CHARS)) {
        if (part.length >= MIN_CHUNK_CHARS) chunks.push(part.trim());
      }
      continue;
    }

    const joined = current ? `${current}\n\n${unit}` : unit;
    if (joined.length > TARGET_CHARS && current.trim()) {
      // Capture the overlap tail BEFORE flush() empties `current`, so consecutive
      // chunks share ~15% context (a boss strategy straddling a boundary isn't halved).
      const tail = current.slice(-OVERLAP_CHARS);
      flush();
      current = tail ? `${tail}\n\n${unit}` : unit;
    } else {
      current = joined;
    }
  }

  flush();

  if (!chunks.length) {
    const fallback = (typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
    return fallback.length >= MIN_CHUNK_CHARS ? [fallback] : [];
  }

  return chunks;
}
