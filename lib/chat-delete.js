import { coverStoragePath } from "./image.js";

/** @param {{ images?: string[] }[]} thread */
export function threadImageStoragePaths(thread) {
  return thread
    .flatMap((message) => (Array.isArray(message.images) ? message.images : []))
    .map(coverStoragePath)
    .filter((path) => Boolean(path));
}

/** @param {string[]} urls */
export function coverUrlsToStoragePaths(urls) {
  return urls.map(coverStoragePath).filter((path) => Boolean(path));
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
