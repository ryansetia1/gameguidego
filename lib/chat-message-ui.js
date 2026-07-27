import { KINDS } from "./highlights.js";
import {
  guideSourceLinkLabel,
  isGamefaqsFaqGuideUrl,
  isSamePreferredGuide,
  isUploadedGuideUrl,
  uploadedGuideFileTypeLabel,
} from "./guide-urls.js";
import { isJournalSourceUrl } from "./player-journey.js";

/**
 * @param {string} url
 */
export function sourceHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

/**
 * Prefer a cached guide title over a stored hostname / "(section N)" label.
 * @param {{ title?: string; url: string }} source
 * @param {Record<string, { title?: string }> | undefined} guideMeta
 */
export function resolveSourceTitle(source, guideMeta) {
  if (isJournalSourceUrl(source.url)) return "Your progress";
  const url = source.url;
  for (const [guideUrl, meta] of Object.entries(guideMeta ?? {})) {
    if (meta?.title?.trim() && isSamePreferredGuide(url, guideUrl)) {
      return meta.title.trim();
    }
  }
  const stripped = (source.title ?? "").replace(/\s*\(section \d+\)\s*$/i, "").trim();
  if (
    stripped &&
    stripped !== sourceHostname(url) &&
    !/^gamefaqs\.gamespot\.com$/i.test(stripped)
  ) {
    return stripped;
  }
  if (isGamefaqsFaqGuideUrl(url)) return guideSourceLinkLabel(url);
  return stripped || source.title || sourceHostname(url);
}

/**
 * @param {Array<{ title?: string; url: string }> | undefined} sources
 * @param {Record<string, { title?: string }> | undefined} guideMeta
 */
export function enrichMessageSources(sources, guideMeta) {
  if (!sources?.length) return sources;
  return sources.map((source) => ({
    ...source,
    title: resolveSourceTitle(source, guideMeta),
  }));
}

/**
 * @param {Array<{ title?: string; url: string }> | undefined} sources
 */
export function uploadedSourceGuideLabel(sources) {
  const uploadSrc = sources?.find((source) => isUploadedGuideUrl(source.url));
  if (!uploadSrc) return null;
  const fileType = uploadedGuideFileTypeLabel(uploadSrc.url);
  if (fileType === "PDF" || fileType === "TXT" || fileType === "MD") {
    return fileType;
  }
  return "Uploaded";
}

/**
 * Short provenance badge for one source row so a mixed-source answer is
 * legible ("this used my PDF plus a GameFAQs link"): file type for uploads,
 * "GameFAQs"/"Guide" for a pasted preferred guide, else "Web". Classifies by
 * the attached preferred-guide URLs (authoritative) rather than guideMeta,
 * which only has an entry once a guide's title has resolved.
 * @param {{ url: string }} source
 * @param {string[] | undefined} preferredUrls
 */
export function sourceBadge(source, preferredUrls) {
  if (isJournalSourceUrl(source.url)) return "Saved from your chats";
  if (isUploadedGuideUrl(source.url)) return uploadedGuideFileTypeLabel(source.url);
  if (isGamefaqsFaqGuideUrl(source.url)) return "GameFAQs";
  const isPreferred = (preferredUrls ?? []).some((url) =>
    isSamePreferredGuide(source.url, url),
  );
  return isPreferred ? "Guide" : "Web";
}

/**
 * Display labels for non-upload answer sources (deduped, stable order).
 * @param {Array<{ title?: string; url: string }> | undefined} sources
 */
export function linkedSourceHosts(sources) {
  const hosts = [];
  const seen = new Set();
  for (const source of sources ?? []) {
    if (isUploadedGuideUrl(source.url)) continue;
    const label = source.title?.trim() || guideSourceLinkLabel(source.url);
    if (seen.has(label)) continue;
    seen.add(label);
    hosts.push(label);
  }
  return hosts;
}

/**
 * Footnote label when both uploaded and linked preferred guides are cited.
 * @param {string | null} uploadLabel
 * @param {string[]} linkHosts
 */
export function mixedPreferredGuideLabel(uploadLabel, linkHosts) {
  if (!uploadLabel || !linkHosts.length) return uploadLabel;
  if (linkHosts.length === 1) return `${uploadLabel} + ${linkHosts[0]}`;
  return `${uploadLabel} + ${linkHosts.length} links`;
}

/**
 * Collapsed Sources foot sub-label. Upload + pasted guide links shorten to
 * "PDF + links" (etc.); the expanded list still shows each file and link.
 * @param {string | undefined} pipelineType
 * @param {Array<{ title?: string; url: string }> | undefined} sources
 */
export function collapsedSourcesSubLabel(pipelineType, sources) {
  const uploadSrc = sources?.find((source) => isUploadedGuideUrl(source.url));
  const linkHosts = linkedSourceHosts(sources);
  if (uploadSrc && linkHosts.length > 0 && pipelineType === "rag") {
    const fileType = uploadedGuideFileTypeLabel(uploadSrc.url);
    return `${fileType} + links`;
  }
  return pipelineSourceLabel(pipelineType, sources);
}

/**
 * @param {string | undefined} pipelineType
 * @param {Array<{ title?: string; url: string }> | undefined} sources
 * @returns {string}
 */
export function pipelineSourceLabel(pipelineType, sources) {
  const uploadLabel = uploadedSourceGuideLabel(sources);
  const linkHosts = linkedSourceHosts(sources);
  const hasLinkSources = linkHosts.length > 0;

  if (uploadLabel) {
    if (pipelineType === "rag" && hasLinkSources) {
      return mixedPreferredGuideLabel(uploadLabel, linkHosts) ?? uploadLabel;
    }
    if (
      pipelineType === "rag_supplemented" ||
      pipelineType === "fallback_web" ||
      (hasLinkSources && pipelineType !== "rag")
    ) {
      return `${uploadLabel} + Web`;
    }
    return uploadLabel;
  }

  if (pipelineType === "rag") return "Your guide";
  if (pipelineType === "rag_supplemented") return "Your guide + Web";
  if (
    pipelineType === "fallback_web" ||
    pipelineType === "web" ||
    pipelineType === "web_skip_guide"
  ) {
    return "Web";
  }
  return "AI knowledge";
}

/**
 * The answer's source mode for the top-of-card chip: `label` is the human
 * string (reuses pipelineSourceLabel), `guideBacked` drives the accent dot vs
 * the muted "from general knowledge" dot and gates the inline upsell.
 *
 * @param {string | undefined} pipelineType
 * @param {Array<{ title?: string; url: string }> | undefined} sources
 */
export function answerModeInfo(pipelineType, sources) {
  const label = pipelineSourceLabel(pipelineType, sources);
  const guideBacked =
    pipelineType === "rag" ||
    pipelineType === "rag_supplemented" ||
    isUploadOnlySources(sources) ||
    /guide/i.test(label);
  // "web" = web search backed the model's knowledge; "knowledge" = no web check
  // this turn. Drives the accuracy caveat copy, not just the accent dot.
  const mode = guideBacked ? "guide" : /web/i.test(label) ? "web" : "knowledge";
  return { label, guideBacked, mode };
}

/**
 * @param {Array<{ title?: string; url: string }> | undefined} sources
 */
export function isUploadOnlySources(sources) {
  return Boolean(
    sources?.length && sources.every((source) => isUploadedGuideUrl(source.url)),
  );
}

/**
 * @param {Array<{ kind: string }>} highlights
 */
export function groupHighlightsByKind(highlights) {
  return KINDS.flatMap((kind) => {
    const items = highlights.filter((highlight) => highlight.kind === kind);
    return items.length ? [{ kind, items }] : [];
  });
}
