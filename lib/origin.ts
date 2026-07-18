/**
 * Request / auth origin helpers.
 *
 * `getRequestOrigin` — whatever host the browser hit (fine for non-auth).
 * `getAuthOrigin` — pinned in production so OpenID realm/return_to and
 * post-login redirects can't be steered by a spoofed Host / X-Forwarded-Host.
 */

export function isLocalDevHost(host: string): boolean {
  const h = host.split(":")[0]?.toLowerCase() ?? "";
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/** Pure: pick auth origin from request origin + pin + extras. Exported for checks. */
export function resolveAuthOrigin(
  requestOrigin: string,
  pinned: string | null,
  extraAllowed: string[] = [],
): string {
  let host = "";
  try {
    host = new URL(requestOrigin).host;
  } catch {
    return pinned ?? "http://localhost:3000";
  }
  if (isLocalDevHost(host)) return requestOrigin;

  if (!pinned) return requestOrigin;

  const allowed = new Set(
    [pinned, ...extraAllowed].map((s) => s.replace(/\/$/, "")),
  );
  if (allowed.has(requestOrigin.replace(/\/$/, ""))) return requestOrigin;
  return pinned;
}

export function getRequestOrigin(req: Request): string {
  const h = req.headers;
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
  const host = (
    h.get("x-forwarded-host") ??
    h.get("host") ??
    "localhost:3000"
  )
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function pinnedSiteOrigin(): string | null {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (site) return site;
  const vercel = process.env.VERCEL_URL?.replace(/^https?:\/\//, "");
  if (vercel) return `https://${vercel}`;
  return null;
}

export function getAuthOrigin(req: Request): string {
  const extras = (process.env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return resolveAuthOrigin(
    getRequestOrigin(req),
    pinnedSiteOrigin(),
    extras,
  );
}
