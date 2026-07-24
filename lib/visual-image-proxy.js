/** @typedef {{ url: string; alt: string; sourceUrl?: string }} Illustration */

const ALLOWED_IMAGE_HOST_SUFFIXES = [
  "wikia.nocookie.net",
  "fandom.com",
  "zeldawiki.wiki",
  "strategywiki.org",
  "game8.co",
  "neoseeker.com",
  "nintendo.com",
  "steamstatic.com",
  "spriters-resource.com",
];

/**
 * @param {string} url
 */
export function isAllowedVisualImageUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_IMAGE_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

/**
 * Same-origin proxy for wiki/CDN images that block hotlinking.
 *
 * @param {string} url
 */
export function visualImageProxyUrl(url) {
  if (!url) return url;
  if (url.startsWith("/api/visual-image?")) return url;
  if (!isAllowedVisualImageUrl(url)) return url;
  return `/api/visual-image?url=${encodeURIComponent(url)}`;
}

/**
 * @param {Illustration | null | undefined}
 * @returns {Illustration | undefined}
 */
export function proxifyIllustration(illustration) {
  if (!illustration?.url) return illustration || undefined;
  return {
    ...illustration,
    url: visualImageProxyUrl(illustration.url),
  };
}
