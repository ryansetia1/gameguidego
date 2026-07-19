// Client-side image downscale + JPEG re-encode, so uploads to Storage stay small
// (covers, message images, avatars). Falls back to the original file on any
// failure. Browser-only (uses canvas / createImageBitmap).

/**
 * @param {File | Blob} file
 * @param {number} [maxDim] longest edge in px
 * @param {number} [quality] JPEG quality 0..1
 * @returns {Promise<Blob>}
 */
export async function compressImage(file, maxDim = 1280, quality = 0.8) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    return await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob ?? file), "image/jpeg", quality),
    );
  } catch {
    return file;
  }
}
