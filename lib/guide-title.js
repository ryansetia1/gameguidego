import { cleanSnippet } from "./clean.js";
import { parseGamefaqsFaqUrl, parseGamefaqsGuideTitle } from "./gamefaqs-bundle.js";
import { detectHeading, HEADING_MIN_CONFIDENCE } from "./guide-outline.js";
import { isUploadedGuideUrl, uploadedGuideFilename } from "./guide-urls.js";

const MAX_TITLE_CHARS = 120;

/**
 * @param {string} title
 * @returns {string}
 */
function capTitle(title) {
  const trimmed = (title ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (trimmed.length <= MAX_TITLE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TITLE_CHARS - 3).trimEnd()}...`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function titleFromUrlPath(url) {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!segment || segment.length < 4) return "";
    const decoded = decodeURIComponent(segment);
    const stripped = decoded
      .replace(/\.(html?|php|aspx?)$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
    return stripped.length >= 4 ? capTitle(stripped) : "";
  } catch {
    return "";
  }
}

/**
 * Best-effort guide display title from extracted page text or URL.
 * GameFAQs uses the dedicated parser; uploads use the filename.
 * @param {string} guideUrl
 * @param {string} [rawContent]
 * @returns {string}
 */
export function parseGuideTitleFromExtract(guideUrl, rawContent = "") {
  if (isUploadedGuideUrl(guideUrl)) {
    return capTitle(uploadedGuideFilename(guideUrl));
  }

  const parsed = parseGamefaqsFaqUrl(guideUrl);
  if (parsed && rawContent) {
    const gamefaqs = parseGamefaqsGuideTitle(rawContent, parsed);
    if (gamefaqs) return capTitle(gamefaqs);
  }

  const text = typeof rawContent === "string" ? rawContent.replace(/\r\n/g, "\n") : "";

  const htmlTitle = text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  if (htmlTitle) {
    const cleaned = capTitle(cleanSnippet(htmlTitle));
    if (cleaned.length >= 3) return cleaned;
  }

  const lines = text.split("\n").slice(0, 50);
  for (let i = 0; i < lines.length; i++) {
    const hit = detectHeading(lines[i], lines[i + 1]);
    if (hit && hit.confidence >= HEADING_MIN_CONFIDENCE && hit.title.length >= 3) {
      return hit.title;
    }
  }

  return titleFromUrlPath(guideUrl);
}
