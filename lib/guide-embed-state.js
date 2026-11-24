/**
 * Pure model-availability and UI index-status rules for dual-vector guide retrieval.
 */

export const AUTO_REFRESH_MAX_CHUNKS = 200;

/**
 * Pick the highest-priority stored embedding model that is currently usable.
 * @param {{
 *   embedModel?: string | null;
 *   embedModelNext?: string | null;
 *   usableModels: Set<string>;
 *   preferredOrder: string[];
 * }} input
 * @returns {{
 *   activeModel: string | null;
 *   degraded: boolean;
 *   canRefresh: boolean;
 *   refreshTarget: string | null;
 * }}
 */
export function resolveGuideModelChoice({
  embedModel,
  embedModelNext,
  usableModels,
  preferredOrder,
}) {
  const primaryDefault = preferredOrder[0] ?? "sumopod";
  const stored = new Set([embedModel || primaryDefault]);
  if (embedModelNext) stored.add(embedModelNext);

  const activeModel =
    preferredOrder.find((model) => stored.has(model) && usableModels.has(model)) ?? null;
  if (activeModel) {
    return { activeModel, degraded: false, canRefresh: false, refreshTarget: null };
  }

  const refreshTarget = preferredOrder.find((model) => usableModels.has(model)) ?? null;
  return {
    activeModel: null,
    degraded: true,
    canRefresh: Boolean(refreshTarget),
    refreshTarget,
  };
}

/**
 * Map a guide's stored vectors + live provider availability into a user-facing state.
 * @param {{
 *   indexed: boolean;
 *   chunkCount: number;
 *   embedModel?: string | null;
 *   embedModelNext?: string | null;
 *   usableModels: Set<string>;
 *   preferredOrder: string[];
 *   isRefreshing?: boolean;
 *   dualRpcReady?: boolean;
 * }} input
 * @returns {{
 *   status: "pending" | "indexed" | "limited" | "refreshing" | "paused";
 *   canRefresh: boolean;
 *   autoRefreshable: boolean;
 * }}
 */
export function classifyGuideIndexStatus({
  indexed,
  chunkCount,
  embedModel,
  embedModelNext,
  usableModels,
  preferredOrder,
  isRefreshing = false,
  dualRpcReady = false,
}) {
  if (!indexed) {
    return { status: "pending", canRefresh: false, autoRefreshable: false };
  }

  const choice = resolveGuideModelChoice({
    embedModel,
    embedModelNext: dualRpcReady ? embedModelNext : null,
    usableModels,
    preferredOrder,
  });

  if (!choice.degraded) {
    return { status: "indexed", canRefresh: false, autoRefreshable: false };
  }
  if (isRefreshing) {
    return { status: "refreshing", canRefresh: false, autoRefreshable: false };
  }
  if (choice.canRefresh) {
    return {
      status: "limited",
      canRefresh: true,
      autoRefreshable: chunkCount > 0 && chunkCount <= AUTO_REFRESH_MAX_CHUNKS,
    };
  }
  return { status: "paused", canRefresh: false, autoRefreshable: false };
}

/**
 * Pick degraded guides eligible for quiet background auto-refresh (small-to-medium guides).
 * @param {Array<{ guideUrl: string; chunkCount: number; canRefresh: boolean }>} degradedGuides
 * @returns {Array<{ guideUrl: string; chunkCount: number }>}
 */
export function selectAutoRefreshTargets(degradedGuides) {
  const seen = new Set();
  /** @type {Array<{ guideUrl: string; chunkCount: number }>} */
  const targets = [];
  for (const item of degradedGuides) {
    if (!item?.guideUrl || seen.has(item.guideUrl)) continue;
    seen.add(item.guideUrl);
    if (item.canRefresh && item.chunkCount > 0 && item.chunkCount <= AUTO_REFRESH_MAX_CHUNKS) {
      targets.push({ guideUrl: item.guideUrl, chunkCount: item.chunkCount });
    }
  }
  return targets;
}
