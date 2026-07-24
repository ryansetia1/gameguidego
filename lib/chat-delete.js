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
