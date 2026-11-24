import { resolveGuideDisplayState } from "./guide-index-state";
import {
  guideUrlsSummary,
  isGamefaqsFaqGuideUrl,
  isUploadedGuideUrl,
  uploadedGuideDisplayType,
  uploadedGuideFilename,
} from "./guide-urls.js";

/**
 * @param {string} url
 * @param {{ title?: string; isBlocked?: boolean } | undefined} meta
 * @param {"unknown" | "checking" | "indexed" | "limited" | "refreshing" | "paused" | "failed" | "blocked" | "unavailable" | "pending" | undefined} globalIndexState
 */
export function gameCardGuideRow(url, meta, globalIndexState) {
  const uploaded = isUploadedGuideUrl(url);
  const gamefaqs = isGamefaqsFaqGuideUrl(url);
  const label = uploaded
    ? `${uploadedGuideDisplayType(url)} · ${uploadedGuideFilename(url)}`
    : meta?.title
      ? meta.title
      : gamefaqs
        ? "GameFAQs guide"
        : guideUrlsSummary([url]);

  return {
    uploaded,
    gamefaqs,
    label,
    state: resolveGuideDisplayState(globalIndexState, meta),
    isBlocked: meta?.isBlocked,
  };
}

export { guideUrlNeedsIngest } from "./guide-index-state";
