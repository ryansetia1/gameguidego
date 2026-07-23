import type { RefObject } from "react";
import type { User } from "@supabase/supabase-js";
import { GameAutocomplete } from "../game-autocomplete";
import { GuideLinkField, type GuideBundleMeta } from "../guide-link-field";
import { PlatformSelect } from "../platform-select";
import { IconGrid, IconPlus, IconX } from "../icons";
import { guideUrlsSummary } from "@/lib/guide-urls.js";
import type { Chat } from "@/lib/supabase";
import { CoverThumb, displayPlatform } from "./cover-thumb";
import { RotatingHeadline, RotatingWord, SteamIcon } from "./hero-marketing";
import { SpoilerToggle } from "./spoiler-toggle";

type GuideIndexState = Record<
  string,
  "unknown" | "checking" | "indexed" | "failed" | "unavailable" | "pending"
>;

export type HomeSetupProps = {
  showHero: boolean;
  showCarousel: boolean;
  showSetupForm: boolean;
  hasRecent: boolean;
  newGameOpen: boolean;
  editingGame: boolean;
  topRef: RefObject<HTMLElement | null>;
  recentGames: Chat[];
  moreGamesCount: number;
  steamConnected: boolean;
  coverEnabled: boolean;
  cover: string;
  pendingCover: File | null;
  game: string;
  platform: string;
  preferredUrls: string[];
  optPanel: "guide" | "spoiler" | null;
  loading: boolean;
  uploadingCover: boolean;
  guideBundleMeta: Record<string, GuideBundleMeta>;
  guideIndexState: GuideIndexState;
  guidePending: boolean;
  gameSpoilerMajor: boolean;
  user: User | null;
  onOpenChat: (chat: Chat) => void;
  onOpenSavedLibrary: () => void;
  onStartNewGame: () => void;
  onOpenSteamLibrary: () => void;
  onSetNewGameOpen: (open: boolean) => void;
  onSetOptPanel: (panel: "guide" | "spoiler" | null | ((cur: "guide" | "spoiler" | null) => "guide" | "spoiler" | null)) => void;
  onGameChange: (value: string) => void;
  onPickGame: (picked: { name: string; year: string; cover: string; platform: string }) => void;
  onPlatformChange: (value: string) => void;
  onSelectCover: (file: File) => void;
  onClearCover: () => void;
  onPreferredUrlsChange: (urls: string[]) => void;
  onBundleMetaChange: (meta: Record<string, GuideBundleMeta>) => void;
  onGuideCheckChange: (checking: boolean) => void;
  onGuidePendingChange: (pending: boolean) => void;
  onRequestConfirm: (opts: {
    message: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  onGameSpoilerChange: (value: boolean) => void;
  onSaveGameMeta: () => void;
};

export function HomeSetup({
  showHero,
  showCarousel,
  showSetupForm,
  hasRecent,
  newGameOpen,
  editingGame,
  topRef,
  recentGames,
  moreGamesCount,
  steamConnected,
  coverEnabled,
  cover,
  pendingCover,
  game,
  platform,
  preferredUrls,
  optPanel,
  loading,
  uploadingCover,
  guideBundleMeta,
  guideIndexState,
  guidePending,
  gameSpoilerMajor,
  user,
  onOpenChat,
  onOpenSavedLibrary,
  onStartNewGame,
  onOpenSteamLibrary,
  onSetNewGameOpen,
  onSetOptPanel,
  onGameChange,
  onPickGame,
  onPlatformChange,
  onSelectCover,
  onClearCover,
  onPreferredUrlsChange,
  onBundleMetaChange,
  onGuideCheckChange,
  onGuidePendingChange,
  onRequestConfirm,
  onGameSpoilerChange,
  onSaveGameMeta,
}: HomeSetupProps) {
  return (
    <>
      {showHero && (
        <div
          className={`hero-shell${newGameOpen && hasRecent ? " hero-shell--exit" : ""}`}
          aria-hidden={newGameOpen && hasRecent}
        >
          <section className={`hero${hasRecent ? " hero--quick" : ""}`}>
            <p className="eyebrow">
              Companion for <RotatingWord />
            </p>
            <RotatingHeadline />
            <p className="intro">
              Say the game and ask away.
              {!hasRecent &&
                " Add a walkthrough you trust and answers come straight from it."}
            </p>
          </section>
        </div>
      )}

      {showCarousel && (
        <section
          className={`quick-home${newGameOpen ? " quick-home--form-open" : ""}`}
          aria-label="Recent games"
          ref={topRef}
        >
          <div className="quick-head">
            <h2>Jump back in</h2>
          </div>
          <div className="quick-rail">
            {recentGames.map((chat) => (
              <button key={chat.id} type="button" className="quick-card" onClick={() => onOpenChat(chat)}>
                <CoverThumb cover={chat.cover_url ?? ""} name={chat.game} className="cover-lg" />
                <span className="quick-card-meta">
                  <strong>{chat.game || "Untitled game"}</strong>
                  {(chat.platform || chat.release_year) && (
                    <small>
                      {[displayPlatform(chat.platform, chat.cover_url), chat.release_year]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  )}
                </span>
              </button>
            ))}
            {moreGamesCount > 0 && (
              <button
                type="button"
                className="quick-card quick-more"
                onClick={onOpenSavedLibrary}
                aria-label={`See ${moreGamesCount} more saved games`}
              >
                <span className="quick-more-count">+{moreGamesCount}</span>
                <span className="quick-card-meta">
                  <strong>more</strong>
                  <small>Open library</small>
                </span>
              </button>
            )}
          </div>
          {!newGameOpen ? (
            <>
              <button type="button" className="quick-new icon-inline" onClick={onStartNewGame}>
                <IconPlus /> New game
              </button>
              <div className="quick-libs">
                <button type="button" className="quick-lib-btn icon-inline" onClick={onOpenSavedLibrary}>
                  <IconGrid /> Saved library
                </button>
                {steamConnected && (
                  <button type="button" className="quick-lib-btn icon-inline" onClick={onOpenSteamLibrary}>
                    <SteamIcon /> Steam library
                  </button>
                )}
              </div>
            </>
          ) : (
            !editingGame && (
              <button
                type="button"
                className="quick-new quick-new--cancel icon-inline"
                onClick={() => onSetNewGameOpen(false)}
              >
                <IconX /> Cancel new game
              </button>
            )
          )}
        </section>
      )}

      {showSetupForm ? (
        <section
          className={`setup${newGameOpen && hasRecent ? " setup--from-quick" : ""}`}
          aria-label="Game context"
          ref={topRef}
        >
          <div className="setup-main">
            {coverEnabled && cover && (
              <div className="field field-cover">
                <div className="cover-edit">
                  <div className="cover-drop has-cover">
                    <CoverThumb cover={cover} name={game} className="cover-setup" />
                    <label className="cover-upload">
                      <span className="cover-upload-label">Replace</span>
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        disabled={uploadingCover || loading}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (file) onSelectCover(file);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="cover-clear"
                      aria-label="Remove cover"
                      onClick={() => void onClearCover()}
                      disabled={uploadingCover || loading}
                    >
                      <IconX />
                    </button>
                  </div>
                  {pendingCover && <span className="cover-pending">Uploads when you send</span>}
                </div>
              </div>
            )}
            <div className="setup-fields">
              <div className="field field-game">
                <div className="field-head">
                  <label htmlFor="game">Game name</label>
                  {coverEnabled && !cover && (
                    <label className="cover-add-btn icon-inline">
                      <IconPlus /> Add cover
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        disabled={uploadingCover || loading}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (file) onSelectCover(file);
                        }}
                      />
                    </label>
                  )}
                </div>
                <GameAutocomplete
                  value={game}
                  onChange={onGameChange}
                  onPick={onPickGame}
                  disabled={loading}
                />
              </div>
              <div className="field field-platform">
                <span className="field-label" id="platform-label">
                  Platform
                </span>
                <PlatformSelect value={platform} onChange={onPlatformChange} />
              </div>
            </div>
          </div>
          <div className="opt-group">
            {optPanel === "guide" ? (
              <div className="opt-panel guide-cta-panel" id="opt-panel-guide">
                <div className="guide-cta-panel-head">
                  <span className="guide-cta-panel-title">
                    {preferredUrls.length > 0 ? "Your guides" : "Add a guide"}
                  </span>
                  <button
                    type="button"
                    className="guide-cta-skip"
                    onClick={async () => {
                      if (guidePending) {
                        const ok = await onRequestConfirm({
                          message:
                            "You picked a guide but haven't added it yet. Close without adding?",
                          confirmLabel: "Close without adding",
                          danger: true,
                        });
                        if (!ok) return;
                      }
                      onSetOptPanel(null);
                    }}
                  >
                    {preferredUrls.length > 0 ? "Close" : "Skip for now"}
                  </button>
                </div>
                <GuideLinkField
                  value={preferredUrls}
                  onChange={onPreferredUrlsChange}
                  bundleMeta={guideBundleMeta}
                  onBundleMetaChange={onBundleMetaChange}
                  onGuideCheckChange={onGuideCheckChange}
                  onPendingChange={onGuidePendingChange}
                  guideIndexState={guideIndexState}
                  game={game}
                  platform={platform}
                  disabled={loading}
                  userId={user?.id}
                  onDone={() => onSetOptPanel(null)}
                  onRequestConfirm={onRequestConfirm}
                />
              </div>
            ) : preferredUrls.length > 0 ? (
              <button
                type="button"
                className="guide-cta is-added"
                aria-expanded={false}
                aria-controls="opt-panel-guide"
                onClick={() => onSetOptPanel("guide")}
              >
                <span className="guide-cta-dot" aria-hidden="true" />
                <span className="guide-cta-body">
                  <strong>{guideUrlsSummary(preferredUrls, guideBundleMeta)}</strong>
                  <small>Answers come straight from your guide.</small>
                </span>
                <span className="guide-cta-cue">Manage</span>
              </button>
            ) : (
              <button
                type="button"
                className="guide-cta"
                aria-expanded={false}
                aria-controls="opt-panel-guide"
                onClick={() => onSetOptPanel("guide")}
              >
                <span className="guide-cta-body">
                  <strong>Back your answers with a guide</strong>
                  <small>Paste a walkthrough, wiki page, or PDF. Not required.</small>
                </span>
                <span className="guide-cta-cue icon-inline">
                  <IconPlus /> Add a guide
                </span>
              </button>
            )}

            <div className="opt-spoiler-row">
              <SpoilerToggle prefs={{ major: gameSpoilerMajor }} onChange={onGameSpoilerChange} compact />
            </div>
          </div>
          {editingGame && (
            <div className="field field-wide setup-done">
              <button
                type="button"
                className="nav-button"
                style={
                  preferredUrls.length > 0
                    ? {
                        background: "var(--signal)",
                        color: "var(--on-signal)",
                        borderColor: "var(--signal)",
                      }
                    : undefined
                }
                onClick={async () => {
                  if (guidePending) {
                    const ok = await onRequestConfirm({
                      message: "You have a guide selected but haven't added it. Close anyway?",
                      confirmLabel: "Close without adding",
                      danger: true,
                    });
                    if (!ok) return;
                  }
                  onSaveGameMeta();
                }}
              >
                Done
              </button>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
