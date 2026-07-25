"use client";

import { useState } from "react";
import { steamAppIdFromCoverUrl } from "@/lib/steam.js";

export function CoverThumb({
  cover,
  name,
  className,
}: {
  cover: string;
  name: string;
  className?: string;
}) {
  // Track the URL that failed so a new cover prop auto-resets (no effect needed).
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const cls = `cover${className ? ` ${className}` : ""}`;
  if (cover && cover !== failedUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        className={cls}
        src={cover}
        alt={`${name || "Game"} cover`}
        onError={() => setFailedUrl(cover)}
      />
    );
  }
  return (
    <span className={`${cls} cover-placeholder`} aria-hidden="true">
      {(name.trim()[0] || "?").toUpperCase()}
    </span>
  );
}

/** Display-only: Steam CDN cover shows "Steam" instead of stored "PC". */
export function displayPlatform(platform: string, coverUrl?: string | null): string {
  return steamAppIdFromCoverUrl(coverUrl ?? "") ? "Steam" : platform;
}
