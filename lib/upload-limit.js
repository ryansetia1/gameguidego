/**
 * Guide upload size cap, shared by the picker and the server. Vercel rejects request
 * bodies over 4.5 MB before our route runs, so 4 MB leaves room for multipart overhead.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024;
export const UPLOAD_TOO_LARGE_MSG = `File is too large. Max ${MAX_UPLOAD_MB} MB.`;

/** @param {number} bytes */
export const isUploadTooLarge = (bytes) => bytes > MAX_UPLOAD_BYTES;

/** Multipart framing allowance on top of the file itself. */
export const UPLOAD_BODY_MARGIN = 64 * 1024;

/**
 * Whether a declared Content-Length is too big to be an allowed upload.
 * A missing or non-numeric header passes; the file.size check still guards it.
 * @param {string | null | undefined} header
 */
export const isBodyTooLarge = (header) => {
  const n = Number(header);
  return header != null && header !== "" && Number.isFinite(n) && n > MAX_UPLOAD_BYTES + UPLOAD_BODY_MARGIN;
};
