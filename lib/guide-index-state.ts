export type GuideIndexStateValue =
  | "unknown"
  | "checking"
  | "indexed"
  | "limited"
  | "refreshing"
  | "paused"
  | "failed"
  | "blocked"
  | "unavailable"
  | "pending";

export type GuideIndexState = Record<string, GuideIndexStateValue>;

export function guideIndexStateFromStatus(item?: {
  status?: string;
  indexed?: boolean;
}): GuideIndexStateValue {
  const s = item?.status;
  if (
    s === "indexed" ||
    s === "limited" ||
    s === "refreshing" ||
    s === "paused" ||
    s === "pending" ||
    s === "unavailable" ||
    s === "failed" ||
    s === "blocked"
  ) {
    return s;
  }
  return item?.indexed ? "indexed" : "pending";
}

export function guideIndexStateFromIngest(
  row?: Record<string, unknown>,
  meta?: { isBlocked?: boolean },
): GuideIndexStateValue {
  if (row?.refreshed === true) return "indexed";
  if (row?.status === "limited" || row?.status === "refreshing" || row?.status === "paused") {
    return row.status;
  }
  if (row?.indexed) return "indexed";
  if (row?.isBlocked === true || meta?.isBlocked) return "blocked";
  return "failed";
}

export function resolveGuideDisplayState(
  state?: GuideIndexStateValue,
  meta?: { isBlocked?: boolean },
): GuideIndexStateValue {
  if (
    state === "indexed" ||
    state === "limited" ||
    state === "refreshing" ||
    state === "paused" ||
    state === "unavailable" ||
    state === "checking"
  ) {
    return state;
  }
  if (meta?.isBlocked) return "blocked";
  return state || "pending";
}

export function guideUrlNeedsIngest(
  url: string,
  indexState?: GuideIndexStateValue,
): boolean {
  void url;
  return (
    indexState !== "indexed" &&
    indexState !== "limited" &&
    indexState !== "refreshing" &&
    indexState !== "paused"
  );
}
