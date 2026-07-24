import { coerceHighlights, coerceSpoilers } from "./highlights.js";

/** @typedef {{ url: string; alt: string; sourceUrl?: string }} Illustration */

/**
 * @param {unknown} value
 * @returns {Illustration | undefined}
 */
export function coerceIllustration(value) {
  if (!value || typeof value !== "object") return undefined;
  const record = /** @type {Record<string, unknown>} */ (value);
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!url.startsWith("http") && !url.startsWith("/api/visual-image?")) return undefined;
  const alt =
    typeof record.alt === "string" && record.alt.trim()
      ? record.alt.trim().slice(0, 120)
      : "Reference image";
  const sourceUrl =
    typeof record.sourceUrl === "string" && record.sourceUrl.startsWith("http")
      ? record.sourceUrl
      : undefined;
  return { url, alt, ...(sourceUrl ? { sourceUrl } : {}) };
}

/** Placeholder content while the assistant answer is generating. */
export const WRITING_ANSWER_PLACEHOLDER = "Writing answer...";

/**
 * @param {unknown} item
 * @returns {Record<string, unknown> | null}
 */
export function coerceMessageVariant(item) {
  if (!item || typeof item !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (item);
  const content = record.content;
  if (typeof content !== "string") return null;
  const rawSources = record.sources;
  const sources = Array.isArray(rawSources) ? rawSources : undefined;
  const highlights = coerceHighlights(record.highlights);
  const spoilers = coerceSpoilers(record.spoilers);
  const pipelineType = typeof record.pipelineType === "string" ? record.pipelineType : undefined;
  const illustration = coerceIllustration(record.illustration);
  return {
    content,
    sources,
    ...(highlights.length ? { highlights } : {}),
    ...(spoilers.length ? { spoilers } : {}),
    ...(pipelineType ? { pipelineType } : {}),
    ...(illustration ? { illustration } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {Array<Record<string, unknown>>}
 */
export function coerceMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = /** @type {Record<string, unknown>} */ (item);
    const role = record.role;
    const content = record.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      return [];
    }
    const rawSources = record.sources;
    const sources = Array.isArray(rawSources) ? rawSources : undefined;
    const highlights = coerceHighlights(record.highlights);
    const spoilers = coerceSpoilers(record.spoilers);
    const rawImages = record.images;
    const images = Array.isArray(rawImages)
      ? rawImages.filter((url) => typeof url === "string")
      : [];
    const pipelineType = typeof record.pipelineType === "string" ? record.pipelineType : undefined;
    const illustration = coerceIllustration(record.illustration);
    const rawVariants = record.variants;
    const variants = Array.isArray(rawVariants)
      ? rawVariants.map(coerceMessageVariant).filter((variant) => variant !== null)
      : [];
    const rawActiveIdx = record.activeVariantIndex;
    const activeVariantIndex =
      typeof rawActiveIdx === "number" &&
      Number.isInteger(rawActiveIdx) &&
      rawActiveIdx >= 0 &&
      rawActiveIdx < variants.length
        ? rawActiveIdx
        : variants.length > 0
          ? variants.length - 1
          : undefined;
    return [
      {
        role,
        content,
        sources,
        ...(highlights.length ? { highlights } : {}),
        ...(spoilers.length ? { spoilers } : {}),
        ...(images.length ? { images } : {}),
        ...(illustration ? { illustration } : {}),
        ...(pipelineType ? { pipelineType } : {}),
        ...(variants.length > 0 ? { variants, activeVariantIndex } : {}),
      },
    ];
  });
}

/**
 * Prior assistant answers kept when the user regenerates. Uses the stored
 * variants array when present; otherwise snapshots the current top-level fields.
 *
 * @param {Record<string, unknown>} assistant
 * @returns {Array<Record<string, unknown>>}
 */
export function snapshotAssistantVariants(assistant) {
  const variants = assistant.variants;
  if (Array.isArray(variants) && variants.length > 0) {
    return variants;
  }
  return [
    {
      content: assistant.content,
      sources: assistant.sources,
      highlights: assistant.highlights,
      spoilers: assistant.spoilers,
      pipelineType: assistant.pipelineType,
      illustration: assistant.illustration,
    },
  ];
}

/**
 * True when a background poll loaded messages that finish a new turn or a regen.
 *
 * @param {Array<Record<string, unknown>>} optimistic
 * @param {Array<Record<string, unknown>>} loaded
 */
export function pollRecoveredMessages(optimistic, loaded) {
  if (loaded.length > optimistic.length) return true;
  const optimisticLast = optimistic.at(-1);
  const loadedLast = loaded.at(-1);
  if (!optimisticLast || !loadedLast) return false;
  return (
    optimisticLast.content === WRITING_ANSWER_PLACEHOLDER &&
    loadedLast.role === "assistant" &&
    loadedLast.content !== WRITING_ANSWER_PLACEHOLDER
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} message
 */
export function messageShowsVariantNav(message) {
  const variants = message?.variants;
  return Array.isArray(variants) && variants.length > 1;
}
