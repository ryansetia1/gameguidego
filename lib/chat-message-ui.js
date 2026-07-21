import { KINDS } from "./highlights.js";
import { isUploadedGuideUrl, uploadedGuideFileTypeLabel } from "./guide-urls.js";

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
 * @param {Array<{ title: string; url: string }> | undefined} sources
 */
export function uploadedSourceGuideLabel(sources) {
  const uploadSrc = sources?.find((source) => isUploadedGuideUrl(source.url));
  if (!uploadSrc) return null;
  const fileType = uploadedGuideFileTypeLabel(uploadSrc.url);
  if (fileType === "PDF" || fileType === "TXT" || fileType === "MD") {
    return `Your ${fileType} guide`;
  }
  return "Your uploaded guide";
}

/**
 * @param {string | undefined} pipelineType
 * @param {Array<{ title: string; url: string }> | undefined} sources
 */
export function pipelineSourceLabel(pipelineType, sources) {
  const uploadLabel = uploadedSourceGuideLabel(sources);
  const hasWebSources = sources?.some((source) => !isUploadedGuideUrl(source.url));

  if (uploadLabel) {
    if (pipelineType === "fallback_web" || (hasWebSources && pipelineType !== "rag")) {
      return `${uploadLabel} + Web search`;
    }
    return uploadLabel;
  }

  if (pipelineType === "rag") return "Your guide";
  if (pipelineType === "fallback_web" || pipelineType === "web") return "Web search";
  return "AI knowledge";
}

/**
 * @param {Array<{ title: string; url: string }> | undefined} sources
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
