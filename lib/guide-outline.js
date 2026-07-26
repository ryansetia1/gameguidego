/** Minimum confidence to treat a line as a section heading. */
export const HEADING_MIN_CONFIDENCE = 0.55;

/** ponytail: Tavily single-line extracts made greedy MD capture the whole guide as a title. */
export const MAX_HEADING_TITLE_CHARS = 120;
const MAX_HEADING_LINE_CHARS = 240;

const RULE_LINE = /^[=\-]{3,}\s*$/;
/** Non-greedy: stop at the next inline markdown heading on the same line. */
const MD_HEADING = /^(#{1,6})\s+(.+?)(?=\s#{1,6}\s|$)/;
const NUMBERED_HEADING = /^(\d+|[IVXLC]+)\.\s+(.+)$/;
const BRACKET_HEADING = /^\[([^\]]+)\]$/;

/**
 * Tavily GameFAQs ?print=1 often returns one giant line with inline ### headings.
 * Split those before outline/chunking when the body has almost no newlines.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeGuideTextForOutline(text) {
  const normalized = typeof text === "string" ? text.replace(/\r\n/g, "\n").trim() : "";
  if (!normalized) return "";
  const lineCount = normalized.split("\n").length;
  if (lineCount <= 3 && normalized.length > 2000) {
    return normalized.replace(/\s+(#{1,6})\s+/g, "\n$1 ");
  }
  return normalized;
}

/**
 * @param {string} title
 * @returns {string}
 */
function capHeadingTitle(title) {
  const trimmed = (title ?? "").replace(/\s+/g, " ").trim();
  if (trimmed.length <= MAX_HEADING_TITLE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_HEADING_TITLE_CHARS - 3).trimEnd()}...`;
}

/**
 * Score a single line as a heading candidate. Returns null when below threshold.
 *
 * @param {string} line
 * @param {string | undefined} nextLine
 * @returns {{ title: string, level: number, confidence: number } | null}
 */
export function detectHeading(line, nextLine) {
  const trimmed = (line ?? "").trim();
  if (!trimmed || trimmed.length < 2) return null;
  if (trimmed.length > MAX_HEADING_LINE_CHARS && !MD_HEADING.test(trimmed)) return null;

  let confidence = 0;
  let level = 2;
  let title = trimmed;

  const md = trimmed.match(MD_HEADING);
  if (md) {
    confidence += 0.9;
    level = md[1].length;
    title = capHeadingTitle(md[2]);
  }

  if (trimmed.length <= MAX_HEADING_LINE_CHARS) {
    const numbered = trimmed.match(NUMBERED_HEADING);
    if (numbered && /^[A-Z0-9]/.test(numbered[2])) {
      confidence += 0.7;
      title = capHeadingTitle(numbered[2]);
    }

    const bracket = trimmed.match(BRACKET_HEADING);
    if (bracket) {
      confidence += 0.65;
      title = capHeadingTitle(bracket[1]);
    }
  }

  if (nextLine && RULE_LINE.test(nextLine.trim())) {
    confidence += 0.85;
    level = 2;
    title = capHeadingTitle(trimmed);
  }

  if (
    trimmed.length <= 72 &&
    trimmed === trimmed.toUpperCase() &&
    /[A-Z]/.test(trimmed) &&
    !/[.!?]$/.test(trimmed) &&
    !RULE_LINE.test(trimmed)
  ) {
    confidence += 0.4;
  }

  if (confidence < HEADING_MIN_CONFIDENCE) return null;
  return { title, level, confidence: Math.min(1, confidence) };
}

/**
 * @param {string} text
 * @returns {{ title: string, level: number, confidence: number, lineIndex: number }[]}
 */
export function buildOutline(text) {
  const normalized = normalizeGuideTextForOutline(text);
  const lines = normalized.split("\n");
  /** @type {{ title: string, level: number, confidence: number, lineIndex: number }[]} */
  const headings = [];

  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    if (next && RULE_LINE.test(next.trim())) {
      const candidate = detectHeading(lines[i], next);
      if (candidate) {
        headings.push({ ...candidate, lineIndex: i });
        i += 1;
        continue;
      }
    }
    const candidate = detectHeading(lines[i], next);
    if (candidate) headings.push({ ...candidate, lineIndex: i });
  }

  return headings;
}

/**
 * Active breadcrumb at a line index (0-based).
 *
 * @param {number} lineIndex
 * @param {{ title: string, level: number, confidence: number, lineIndex: number }[]} headings
 * @returns {{ path: string[], confidence: number }}
 */
export function sectionAtLine(lineIndex, headings) {
  /** @type {{ title: string, level: number, confidence: number }[]} */
  const stack = [];
  let confidence = 0;

  for (const heading of headings) {
    if (heading.lineIndex > lineIndex) break;
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    stack.push(heading);
    confidence = heading.confidence;
  }

  return { path: stack.map((row) => row.title), confidence };
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {{ path: string[], confidence: number }}
 */
export function sectionAtTextOffset(text, offset) {
  const normalized = normalizeGuideTextForOutline(text);
  const safeOffset = Math.max(0, Math.min(offset, normalized.length));
  const lineIndex = safeOffset ? normalized.slice(0, safeOffset).split("\n").length - 1 : 0;
  return sectionAtLine(lineIndex, buildOutline(normalized));
}

/**
 * Find section metadata for a snippet inside a larger guide body.
 *
 * @param {string} text
 * @param {string} snippet
 * @param {number} [searchFrom]
 * @returns {{ path: string[], confidence: number, offset: number }}
 */
export function sectionForSnippet(text, snippet, searchFrom = 0) {
  const needle = (snippet ?? "").trim().slice(0, 96);
  if (!needle) return { path: [], confidence: 0, offset: searchFrom };
  const idx = text.indexOf(needle, searchFrom);
  if (idx < 0) return { path: [], confidence: 0, offset: searchFrom };
  const section = sectionAtTextOffset(text, idx);
  return { ...section, offset: idx };
}
