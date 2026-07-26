import {
  MAX_HEADING_TITLE_CHARS,
  normalizeGuideTextForOutline,
  sectionForSnippet,
} from "./guide-outline.js";

// ponytail: ~4 chars/token heuristic; good enough for chunk sizing, not billing.
const CHARS_PER_TOKEN = 4;
export const TARGET_CHARS = 500 * CHARS_PER_TOKEN;
const OVERLAP_CHARS = Math.floor(TARGET_CHARS * 0.15);
const MIN_CHUNK_CHARS = 40;
export const SECTION_EMBED_MIN_CONFIDENCE = 0.5;
/** Safety net when outline metadata is wrong or huge. */
export const MAX_EMBED_PREFIX_CHARS = 500;

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
 * @param {{ section_path?: string[], section_confidence?: number }} chunk
 * @returns {string}
 */
export function formatEmbedPrefix(chunk) {
  const path = chunk.section_path ?? [];
  const confidence = chunk.section_confidence ?? 0;
  if (!path.length || confidence < SECTION_EMBED_MIN_CONFIDENCE) return "";
  const capped = path.map((part) => {
    const trimmed = String(part).replace(/\s+/g, " ").trim();
    if (trimmed.length <= MAX_HEADING_TITLE_CHARS) return trimmed;
    return `${trimmed.slice(0, MAX_HEADING_TITLE_CHARS - 3).trimEnd()}...`;
  });
  let breadcrumb = capped.join(" > ");
  if (breadcrumb.length > MAX_EMBED_PREFIX_CHARS) {
    breadcrumb = `${breadcrumb.slice(0, MAX_EMBED_PREFIX_CHARS - 3).trimEnd()}...`;
  }
  return `[Section: ${breadcrumb}]\n`;
}

/**
 * @param {string} sourceText
 * @param {string} chunkText
 * @param {number} searchFrom
 * @returns {{ section_path: string[], section_confidence: number, searchFrom: number }}
 */
function metaForChunk(sourceText, chunkText, searchFrom) {
  const paragraphs = chunkText.trim().split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const lastPara = paragraphs[paragraphs.length - 1] ?? chunkText;
  const head = sectionForSnippet(sourceText, chunkText, searchFrom);
  const tail = sectionForSnippet(sourceText, lastPara, searchFrom);
  const pick = tail.offset >= head.offset ? tail : head;
  return {
    section_path: pick.path,
    section_confidence: pick.confidence,
    searchFrom: pick.offset > searchFrom ? pick.offset + 1 : searchFrom,
  };
}

/**
 * Structure-aware chunking with outline metadata per chunk.
 *
 * @param {string} text
 * @returns {{ text: string, section_path: string[], section_confidence: number, chunk_index: number }[]}
 */
export function chunkGuideWithMeta(text) {
  const sourceText = normalizeGuideTextForOutline(typeof text === "string" ? text : "");
  const units = splitIntoUnits(sourceText);
  if (!units.length) return [];

  /** @type {{ text: string, section_path: string[], section_confidence: number, chunk_index: number }[]} */
  const chunks = [];
  let current = "";
  let searchFrom = 0;

  /**
   * @param {string} chunkText
   * @param {{ section_path: string[], section_confidence: number, searchFrom: number }=} meta
   */
  const pushChunk = (chunkText, meta) => {
    const trimmed = chunkText.trim();
    if (trimmed.length < MIN_CHUNK_CHARS) return;
    const resolved = meta ?? metaForChunk(sourceText, trimmed, searchFrom);
    searchFrom = resolved.searchFrom;
    chunks.push({
      text: trimmed,
      section_path: resolved.section_path,
      section_confidence: resolved.section_confidence,
      chunk_index: chunks.length,
    });
  };

  const flush = () => {
    if (!current.trim()) return;
    pushChunk(current);
    current = "";
  };

  for (const unit of units) {
    if (/^#{1,3}\s/.test(unit) && current.trim()) flush();

    if (unit.length > TARGET_CHARS) {
      flush();
      for (const part of splitOversized(unit, TARGET_CHARS)) {
        pushChunk(part);
      }
      continue;
    }

    const joined = current ? `${current}\n\n${unit}` : unit;
    if (joined.length > TARGET_CHARS && current.trim()) {
      const tail = current.slice(-OVERLAP_CHARS);
      flush();
      current = tail ? `${tail}\n\n${unit}` : unit;
    } else {
      current = joined;
    }
  }

  flush();

  if (!chunks.length) {
    const fallback = sourceText.replace(/\s+/g, " ").trim();
    if (fallback.length >= MIN_CHUNK_CHARS) {
      const meta = metaForChunk(sourceText, fallback, 0);
      return [
        {
          text: fallback,
          section_path: meta.section_path,
          section_confidence: meta.section_confidence,
          chunk_index: 0,
        },
      ];
    }
  }

  return chunks.map((chunk, chunk_index) => ({ ...chunk, chunk_index }));
}

/**
 * Structure-aware chunking for guide pages: headings / rules / paragraphs,
 * packed to ~500 tokens with ~15% overlap between consecutive chunks.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function chunkGuide(text) {
  return chunkGuideWithMeta(text).map((chunk) => chunk.text);
}
