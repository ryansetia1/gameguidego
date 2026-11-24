import { isUploadedGuideUrl } from "./guide-urls.js";
import { coverStoragePath } from "./image.js";

/** @param {{ images?: string[] }[]} thread @returns {string[]} */
export function threadImageStoragePaths(thread) {
  return /** @type {string[]} */ (
    thread
      .flatMap((message) => (Array.isArray(message.images) ? message.images : []))
      .map(coverStoragePath)
      .filter(Boolean)
  );
}

/** @param {string[]} urls @returns {string[]} */
export function coverUrlsToStoragePaths(urls) {
  return /** @type {string[]} */ (urls.map(coverStoragePath).filter(Boolean));
}

/**
 * Filter an iterable of candidate values to unique `upload://` guide keys.
 * @param {Iterable<unknown> | null | undefined} urls
 * @returns {string[]}
 */
export function collectUploadedGuideUrls(urls) {
  if (!urls) return [];
  /** @type {Set<string>} */
  const unique = new Set();
  for (const url of urls) {
    if (isUploadedGuideUrl(url)) {
      unique.add(/** @type {string} */ (url));
    }
  }
  return [...unique];
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string[]} paths
 */
export async function removeCoverStoragePaths(supabase, paths) {
  if (!paths.length) return;
  try {
    await supabase.storage.from("covers").remove(paths);
  } catch (caught) {
    console.error("Storage cleanup failed:", caught);
  }
}

/**
 * Best-effort cleanup of uploaded guide chunks via DELETE /api/guide-upload.
 * ponytail: DELETE /api/guide-upload enforces otherRoomReferences server-side, so shared
 * uploads stay intact; client delete/cancel flows must not fail if a purge call errors.
 * @param {{ supabase: import("@supabase/supabase-js").SupabaseClient | null | undefined, urls: Iterable<unknown> | null | undefined, game?: string, platform?: string }} params
 * @returns {Promise<void>}
 */
export async function purgeUploadedGuides({ supabase, urls, game = "", platform = "" }) {
  const uploadUrls = collectUploadedGuideUrls(urls);
  if (!uploadUrls.length || !supabase) return;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return;
    const cleanGame = String(game ?? "").trim();
    const cleanPlatform = String(platform ?? "").trim();
    const results = await Promise.allSettled(
      uploadUrls.map(async (guideUrl) => {
        const res = await fetch("/api/guide-upload", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            guideUrl,
            game: cleanGame,
            platform: cleanPlatform,
          }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      }),
    );
    for (const outcome of results) {
      if (outcome.status === "rejected") {
        console.error("Uploaded guide cleanup failed:", outcome.reason);
      }
    }
  } catch (caught) {
    console.error("Uploaded guide cleanup failed:", caught);
  }
}
