import type { MouseEvent, RefObject } from "react";
import type { User } from "@supabase/supabase-js";
import { GuideLinkField, type GuideMeta } from "../guide-link-field";
import { HltbRow } from "../hltb-row";
import {
  IconArrowUpRight,
  IconChevronDown,
  IconDotsVertical,
  IconIncognito,
  IconPlus,
  IconRefresh,
} from "../icons";
import { gameCardGuideRow } from "@/lib/guide-card-ui.js";
import { guideUrlDedupeKey } from "@/lib/guide-urls.js";
import { steamAppIdFromCoverUrl } from "@/lib/steam.js";
import { CoverThumb, displayPlatform } from "./cover-thumb";
import { GuideStatusChip } from "./guide-status-chip";
import { SpoilerToggle } from "./spoiler-toggle";
import { TopicTitleTypewriter } from "./topic-title-typewriter";
import { JourneyPanel } from "./journey-panel";

import type { GuideIndexState } from "@/lib/guide-index-state";

export type ActiveGameCardProps = {
  topRef: RefObject<HTMLElement | null>;
  coverEnabled: boolean;
  cover: string;
  game: string;
  platform: string;
  catalogGameId?: number | null;
  releaseYear: string;
  activeChatId: string | null;
  temporary: boolean;
  loading: boolean;
  menuOpenId: string | null;
  preferredUrls: string[];
  guideMeta: Record<string, GuideMeta>;
  guideIndexState: GuideIndexState;
  showQuickAdd: boolean;
  guidePending: boolean;
  retryingUrl: string | null;
  isReindexingAll: boolean;
  gameSpoilerMajor: boolean;
  user: User | null;
  onToggleTemporary: () => void;
  onToggleRowMenu: (id: string, event: React.MouseEvent<HTMLButtonElement>) => void;
  onEditGame: () => void;
  onNewTopic: () => void;
  onClearActiveChat: () => void;
  chatHasMessages: boolean;
  onDeleteActiveChat: () => void;
  /** Thread only: delete the open topic row. */
  onDeleteTopic?: () => void;
  onSetShowQuickAdd: (value: boolean) => void;
  onPreferredUrlsChange: (urls: string[]) => void;
  onGuideMetaChange: (meta: Record<string, GuideMeta>) => void;
  onGuideCheckChange: (checking: boolean) => void;
  onGuidePendingChange: (pending: boolean) => void;
  onRequestConfirm: (opts: {
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  onSaveGameMeta: () => void;
  onGuideCommitted?: (info: { label: string; updated?: boolean }) => void;
  onRetryGuideIngest: (url: string) => void;
  onReindexAllPending: () => void;
  onGameSpoilerChange: (value: boolean) => void;
  /** Thread: New topic / Clear chat / Delete topic. Topics list: Delete all topics / Delete game. */
  menuVariant?: "thread" | "topics";
  topicCount?: number;
  /** Shown below game metadata in thread view. */
  topicTitle?: string;
  topicTitlePending?: boolean;
  onDeleteAllTopics?: () => void;
  journeyEnabled?: boolean;
  journeyExpanded?: boolean;
  onJourneyExpandedChange?: (open: boolean) => void;
  onJourneyToast?: (message: string) => void;
  /** Saved answers for this game; the menu item opens the saved drawer. */
  savedCount?: number;
  onOpenSaved?: () => void;
  /** Saved VGMaps maps for this game; button + menu item open the Maps panel. */
  savedMapsCount?: number;
  onOpenMaps?: () => void;
  className?: string;
};

export function ActiveGameCard({
  topRef,
  coverEnabled,
  cover,
  game,
  platform,
  catalogGameId = null,
  releaseYear,
  activeChatId,
  temporary,
  loading,
  menuOpenId,
  preferredUrls,
  guideMeta,
  guideIndexState,
  showQuickAdd,
  guidePending,
  retryingUrl,
  isReindexingAll,
  gameSpoilerMajor,
  user,
  onToggleTemporary,
  onToggleRowMenu,
  onEditGame,
  onNewTopic,
  onClearActiveChat,
  chatHasMessages,
  onDeleteActiveChat,
  onDeleteTopic,
  onSetShowQuickAdd,
  onPreferredUrlsChange,
  onGuideMetaChange,
  onGuideCheckChange,
  onGuidePendingChange,
  onRequestConfirm,
  onSaveGameMeta,
  onGuideCommitted,
  onRetryGuideIngest,
  onReindexAllPending,
  onGameSpoilerChange,
  menuVariant = "thread",
  topicCount = 0,
  topicTitle = "",
  topicTitlePending = false,
  onDeleteAllTopics,
  journeyEnabled = false,
  journeyExpanded = false,
  onJourneyExpandedChange,
  onJourneyToast,
  savedCount = 0,
  onOpenSaved,
  savedMapsCount = 0,
  onOpenMaps,
  className,
}: ActiveGameCardProps) {
  const hasBlocked = preferredUrls.some(
    (url) => guideIndexState[url] === "blocked" || guideMeta[url]?.isBlocked,
  );
  const hasFailed = preferredUrls.some((url) => guideIndexState[url] === "failed");
  const hasLimited = preferredUrls.some((url) => guideIndexState[url] === "limited");
  const hasRefreshing = preferredUrls.some((url) => guideIndexState[url] === "refreshing");
  const isCollapsible = preferredUrls.length > 2;

  const openQuickAdd = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSetShowQuickAdd(true);
  };

  const renderAddGuideLink = (className = "") => (
    <button
      type="button"
      className={`game-card-quick-add-link${className ? ` ${className}` : ""}`}
      onClick={openQuickAdd}
      disabled={loading}
    >
      <IconPlus size={14} aria-hidden />
      Add guide
    </button>
  );

  const renderQuickAdd = () => {
    if (!showQuickAdd) {
      if (preferredUrls.length > 0) return null;
      return (
        <div className="game-card-quick-add">
          <button
            type="button"
            className="nav-button game-card-quick-add-btn"
            onClick={() => onSetShowQuickAdd(true)}
            disabled={loading}
          >
            <IconPlus size={14} style={{ marginRight: "6px" }} aria-hidden />
            Quick Add Guide
          </button>
        </div>
      );
    }

    return (
      <div className="game-card-quick-add">
        <div className="game-card-quick-add-panel opt-panel">
          <GuideLinkField
            value={preferredUrls}
            onChange={onPreferredUrlsChange}
            guideMeta={guideMeta}
            onGuideMetaChange={onGuideMetaChange}
            onGuideCheckChange={onGuideCheckChange}
            onPendingChange={onGuidePendingChange}
            guideIndexState={guideIndexState}
            game={game}
            platform={platform}
            disabled={loading}
            userId={user?.id}
            onGuideCommitted={(info) => {
              onSetShowQuickAdd(false);
              onGuideCommitted?.(info);
            }}
            onRequestConfirm={onRequestConfirm}
          />
          <div className="game-card-quick-add-done">
            <button
              type="button"
              className="nav-button game-card-quick-add-done-btn"
              onClick={async () => {
                if (guidePending) {
                  const ok = await onRequestConfirm({
                    message: "You have a guide selected but haven't added it. Close anyway?",
                    confirmLabel: "Close without adding",
                    danger: true,
                  });
                  if (!ok) return;
                }
                onSetShowQuickAdd(false);
                onSaveGameMeta();
              }}
              disabled={loading}
              data-has-guides={preferredUrls.length > 0 ? true : undefined}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderRowAction = (url: string, state: string) => {
    if (state === "limited") {
      return (
        <button
          type="button"
          className="guide-refresh-action"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRetryGuideIngest(url);
          }}
          disabled={retryingUrl === url || isReindexingAll}
          title="Restore full search for this guide"
          aria-label="Refresh this guide"
        >
          <IconRefresh size={12} className={retryingUrl === url ? "spin" : ""} />
          Refresh
        </button>
      );
    }
    if (!state || state === "pending" || state === "failed" || state === "blocked" || state === "unknown") {
      return (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRetryGuideIngest(url);
          }}
          disabled={retryingUrl === url || isReindexingAll}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--muted)",
            display: "flex",
            padding: "2px",
            flexShrink: 0,
            opacity: retryingUrl === url || isReindexingAll ? 0.5 : 1,
          }}
          title="Reindex this guide"
          aria-label="Reindex this guide"
        >
          <IconRefresh size={14} className={retryingUrl === url ? "spin" : ""} />
        </button>
      );
    }
    return null;
  };

  const renderGuideStack = (url: string) => {
    const row = gameCardGuideRow(url, guideMeta[url], guideIndexState[url]);
    const rowAction = renderRowAction(url, row.state);
    return (
      <div key={guideUrlDedupeKey(url)} className="game-card-guide-stack">
        <div className="game-card-guide-row">
          <div className="game-card-guide-row-main">
        {row.uploaded ? (
          <div className={`game-card-link is-${row.state}`}>
            <span
              className="icon-inline"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "nowrap",
                overflow: "hidden",
                width: "100%",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {row.label}
              </span>
              {row.state && row.state !== "unknown" && (
                <span style={{ flexShrink: 0 }}>
                  <GuideStatusChip state={row.state} />
                </span>
              )}
              {rowAction}
              <span style={{ flexShrink: 0, width: "20px", display: "flex" }} />
            </span>
          </div>
        ) : (
          <a
            className={`game-card-link is-${row.state}`}
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-busy={row.state === "checking" || row.state === "refreshing" ? true : undefined}
          >
            <span
              className="icon-inline"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "nowrap",
                overflow: "hidden",
                width: "100%",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {row.label}
              </span>
              {row.state && row.state !== "unknown" && (
                <span style={{ flexShrink: 0 }}>
                  <GuideStatusChip state={row.state} />
                </span>
              )}
              {rowAction}
              <span style={{ flexShrink: 0, display: "flex" }}>
                <IconArrowUpRight />
              </span>
            </span>
          </a>
        )}
          </div>
        </div>
      </div>
    );
  };

  const showAddGuideRow = !showQuickAdd && !isCollapsible && preferredUrls.length > 0;

  const gameCardClass = className ? `game-card ${className}` : "game-card";
  const showIncognito = !temporary && (Boolean(activeChatId) || menuVariant === "topics");
  const showMaps = Boolean(onOpenMaps);
  const mapsLabel = savedMapsCount > 0 ? `Maps, ${savedMapsCount} saved` : "Maps";
  // The labelled Maps button is wider than the square incognito one; reserve its room.
  const metaQuickClass = showMaps
    ? showIncognito
      ? " has-quick-maps-2"
      : " has-quick-maps"
    : showIncognito
      ? " has-quick"
      : "";

  return (
    <section className={gameCardClass} aria-label="Game" ref={topRef}>
      {showMaps && (
        <button
          type="button"
          className={`game-card-maps${showIncognito ? " beside-incognito" : ""}`}
          aria-label={mapsLabel}
          onClick={onOpenMaps}
        >
          Maps
          {savedMapsCount > 0 && (
            <span className="game-card-maps-count" aria-hidden="true">
              ({savedMapsCount})
            </span>
          )}
        </button>
      )}
      {showIncognito && (
        <button
          type="button"
          className="game-card-incognito"
          title="Start a temporary chat"
          aria-label="Start a temporary chat"
          disabled={loading}
          onClick={onToggleTemporary}
        >
          <IconIncognito size={18} />
        </button>
      )}
      <div className="row-menu game-card-menu">
        <button
          type="button"
          className="kebab"
          aria-label="Game options"
          aria-expanded={menuOpenId === "game-card"}
          onClick={(event) => onToggleRowMenu("game-card", event)}
          disabled={loading}
        >
          <IconDotsVertical />
        </button>
        {menuOpenId === "game-card" && (
          <div className="row-menu-pop" role="menu">
            {onOpenSaved && (
              <button type="button" className="row-menu-item" onClick={onOpenSaved}>
                Saved answers{savedCount > 0 ? ` (${savedCount})` : ""}
              </button>
            )}
            {onOpenMaps && (
              <button type="button" className="row-menu-item" onClick={onOpenMaps}>
                Maps{savedMapsCount > 0 ? ` (${savedMapsCount})` : ""}
              </button>
            )}
            <button type="button" className="row-menu-item" onClick={onEditGame}>
              Edit
            </button>
            {menuVariant === "topics" ? (
              <>
                {topicCount > 0 ? (
                  <button
                    type="button"
                    className="row-menu-item row-menu-delete"
                    disabled={loading}
                    onClick={() => void onDeleteAllTopics?.()}
                  >
                    Delete all topics
                  </button>
                ) : null}
                <button
                  type="button"
                  className="row-menu-item row-menu-delete"
                  onClick={() => void onDeleteActiveChat()}
                >
                  Delete game
                </button>
              </>
            ) : (
              <>
                <button type="button" className="row-menu-item" onClick={onNewTopic} disabled={loading}>
                  New topic
                </button>
                <button
                  type="button"
                  className="row-menu-item"
                  disabled={!chatHasMessages || loading}
                  onClick={() => void onClearActiveChat()}
                >
                  Clear chat
                </button>
                <button
                  type="button"
                  className="row-menu-item row-menu-delete"
                  disabled={!activeChatId || loading}
                  onClick={() => void onDeleteTopic?.()}
                >
                  Delete topic
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="game-card-header">
        {coverEnabled && (
          <CoverThumb cover={cover} name={game} className="cover-lg game-card-cover" />
        )}
        <div className={`game-card-meta${metaQuickClass}`}>
          <h2>{game || "Untitled game"}</h2>
          {(platform || releaseYear || game) && (
            <p className="meta-subline game-card-meta-line">
              {displayPlatform(platform, cover) && (
                <span className="meta-chunk">{displayPlatform(platform, cover)}</span>
              )}
              {displayPlatform(platform, cover) && releaseYear && (
                <span className="meta-dot" aria-hidden>
                  ·
                </span>
              )}
              {releaseYear && <span className="meta-chunk">{releaseYear}</span>}
              <HltbRow
                title={game}
                appId={steamAppIdFromCoverUrl(cover)?.toString()}
                variant="inline"
                sep={Boolean(displayPlatform(platform, cover) || releaseYear)}
              />
            </p>
          )}
        </div>
      </div>
      {menuVariant === "thread" && (topicTitlePending || topicTitle) ? (
        <TopicTitleTypewriter
          as="p"
          className="game-card-topic-title"
          title={topicTitle}
          pending={topicTitlePending}
        />
      ) : null}
      <JourneyPanel
        user={user}
        game={game}
        platform={platform}
        catalogGameId={catalogGameId}
        journeyEnabled={journeyEnabled}
        loading={loading}
        expanded={journeyExpanded}
        onExpandedChange={onJourneyExpandedChange}
        onToast={onJourneyToast}
      />
      <div className="game-card-guides">
        <details
          className={isCollapsible ? "sources game-card-guides-hidden" : ""}
          open={isCollapsible ? showQuickAdd || undefined : true}
          style={!isCollapsible ? { display: "contents" } : undefined}
        >
          <summary
            className={isCollapsible ? "game-card-guides-summary" : undefined}
            style={!isCollapsible ? { display: "none" } : undefined}
          >
            <span className="game-card-guides-summary-label">Guides ({preferredUrls.length})</span>
            {preferredUrls.some((url) => {
              const st = guideIndexState[url];
              return !st || st === "pending" || st === "limited" || st === "failed" || st === "blocked" || st === "unknown";
            }) && (
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onReindexAllPending();
                }}
                disabled={isReindexingAll}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--muted)",
                  display: "flex",
                  padding: "4px",
                  flexShrink: 0,
                  opacity: isReindexingAll ? 0.5 : 1,
                }}
                title="Reindex or refresh guides"
                aria-label="Reindex or refresh guides"
              >
                <IconRefresh size={14} className={isReindexingAll ? "spin" : ""} />
              </button>
            )}
            {hasBlocked && (
              <GuideStatusChip state="blocked" />
            )}
            {hasFailed && (
              <GuideStatusChip state="failed" />
            )}
            {hasLimited && <GuideStatusChip state="limited" />}
            {!hasLimited && hasRefreshing && <GuideStatusChip state="refreshing" />}
            {isCollapsible && !showQuickAdd
              ? renderAddGuideLink("game-card-quick-add-summary")
              : null}
            {isCollapsible ? (
              <span className="chevron-toggle" aria-hidden>
                <IconChevronDown size={14} />
              </span>
            ) : null}
          </summary>

          <div
            className={isCollapsible ? "game-card-guides" : ""}
            style={isCollapsible ? { marginTop: "8px" } : undefined}
          >
            {!showQuickAdd ? preferredUrls.map((url) => renderGuideStack(url)) : null}
            {showAddGuideRow ? (
              <div className="game-card-guide-add-row">
                {renderAddGuideLink("game-card-quick-add-row")}
              </div>
            ) : null}
            {renderQuickAdd()}
          </div>
        </details>
      </div>
      {menuVariant !== "topics" ? (
        <div className="opt-spoiler-row game-card-spoiler">
          <SpoilerToggle prefs={{ major: gameSpoilerMajor }} onChange={onGameSpoilerChange} compact />
        </div>
      ) : null}
    </section>
  );
}
