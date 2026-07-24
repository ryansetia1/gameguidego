import type { MouseEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { ClearButton } from "../clear-button";
import {
  IconDotsVertical,
  IconGrid,
  IconHome,
  IconChevronLeft,
  IconPlus,
  IconX,
} from "../icons";
import { SteamLibrary, type SteamGame } from "../steam-library";
import type { Chat } from "@/lib/supabase";
import { gameRoomKey } from "@/lib/game-room.js";
import { CoverThumb, displayPlatform } from "./cover-thumb";
import { SteamIcon } from "./hero-marketing";

export type GamesSidebarProps = {
  visible: boolean;
  user: User | null;
  chats: Chat[];
  activeChatId: string | null;
  activeRoomKey: string | null;
  sidebarOpen: boolean;
  libraryOpen: boolean;
  steamLibraryOpen: boolean;
  steamConnected: boolean;
  steamId: string | null;
  menuOpenId: string | null;
  librarySearch: string;
  onDismissOverlay: () => void;
  onCloseSidebar: () => void;
  onGoHome: () => void;
  showBackToGame?: boolean;
  onBackToGame?: () => void;
  onOpenSavedLibrary: () => void;
  onConnectSteam: () => void;
  onOpenSteamLibrary: () => void;
  onOpenChat: (chat: Chat) => void;
  onToggleRowMenu: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
  onEditGame: (chat: Chat, event: MouseEvent<HTMLButtonElement>) => void;
  onDeleteChat: (chat: Chat, event?: MouseEvent<HTMLButtonElement>) => void;
  onStartNewGame: () => void;
  onLibrarySearchChange: (value: string) => void;
  onOpenFromLibrary: (chat: Chat) => void;
  onEditFromLibrary: (chat: Chat) => void;
  onPickSteamGame: (game: SteamGame) => void;
};

export function GamesSidebar({
  visible,
  user,
  chats,
  activeChatId,
  activeRoomKey,
  sidebarOpen,
  libraryOpen,
  steamLibraryOpen,
  steamConnected,
  steamId,
  menuOpenId,
  librarySearch,
  onDismissOverlay,
  onCloseSidebar,
  onGoHome,
  showBackToGame = false,
  onBackToGame,
  onOpenSavedLibrary,
  onConnectSteam,
  onOpenSteamLibrary,
  onOpenChat,
  onToggleRowMenu,
  onEditGame,
  onDeleteChat,
  onStartNewGame,
  onLibrarySearchChange,
  onOpenFromLibrary,
  onEditFromLibrary,
  onPickSteamGame,
}: GamesSidebarProps) {
  if (!visible) return null;

  return (
    <>
      <div
        className={`sidebar-backdrop${sidebarOpen ? " open" : ""}`}
        onClick={onCloseSidebar}
        aria-hidden="true"
      />
      <aside
        className={`sidebar${sidebarOpen ? " open" : ""}`}
        aria-label="Game navigation"
        aria-hidden={!sidebarOpen}
      >
        <div className="sidebar-top">
          <div className="sidebar-top-nav">
            <button type="button" className="sidebar-home icon-inline" onClick={onGoHome}>
              <IconHome /> Home
            </button>
            {showBackToGame && onBackToGame ? (
              <button type="button" className="sidebar-home icon-inline" onClick={onBackToGame}>
                <IconChevronLeft /> Back to game
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="sidebar-close"
            aria-label="Close sidebar"
            onClick={onCloseSidebar}
          >
            <IconX />
          </button>
        </div>
        <div className="sidebar-head">
          <span>Your games</span>
        </div>
        <div className="sidebar-actions">
          <button type="button" className="sidebar-library-btn icon-inline" onClick={onOpenSavedLibrary}>
            <IconGrid /> Saved library
          </button>
          {user && !steamConnected && (
            <button type="button" className="sidebar-steam-btn" onClick={onConnectSteam}>
              <SteamIcon /> Connect Steam
            </button>
          )}
          {steamConnected && (
            <button type="button" className="sidebar-steam-btn" onClick={onOpenSteamLibrary}>
              <SteamIcon /> Steam library
            </button>
          )}
        </div>
        <div className="sidebar-scroll">
          {chats.length === 0 ? (
            <p className="sidebar-empty">No saved games yet.</p>
          ) : (
            <ul className="sidebar-list">
              {chats.map((chat) => (
                <li
                  key={chat.id}
                  className={`sidebar-row${
                    chat.id === activeChatId ||
                    (activeRoomKey && gameRoomKey(chat.game, chat.platform) === activeRoomKey)
                      ? " active"
                      : ""
                  }`}
                >
                  <button type="button" className="sidebar-open" onClick={() => onOpenChat(chat)}>
                    <CoverThumb cover={chat.cover_url ?? ""} name={chat.game} className="cover-sm" />
                    <span className="sidebar-meta">
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
                  <div className="row-menu">
                    <button
                      type="button"
                      className="kebab"
                      aria-label={`Options for ${chat.game || "Untitled game"}`}
                      aria-expanded={menuOpenId === chat.id}
                      onClick={(event) => onToggleRowMenu(chat.id, event)}
                    >
                      <IconDotsVertical />
                    </button>
                    {menuOpenId === chat.id && (
                      <div className="row-menu-pop" role="menu">
                        <button
                          type="button"
                          className="row-menu-item"
                          onClick={(event) => onEditGame(chat, event)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="row-menu-item row-menu-delete"
                          onClick={(event) => void onDeleteChat(chat, event)}
                        >
                          Delete game
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="sidebar-footer">
            <button type="button" className="sidebar-new icon-inline" onClick={onStartNewGame}>
              <IconPlus /> New game
            </button>
          </div>
        </div>
      </aside>

      {libraryOpen && (
        <>
          <button
            type="button"
            className="library-backdrop open"
            aria-label="Close library"
            onClick={onDismissOverlay}
          />
          <div className="library open" role="dialog" aria-label="Saved library">
            <div className="library-panel">
              <div className="library-head">
                <span>Saved library</span>
                <button
                  type="button"
                  className="sidebar-close"
                  aria-label="Close library"
                  onClick={onDismissOverlay}
                >
                  <IconX />
                </button>
              </div>
              {chats.length === 0 ? (
                <p className="library-empty">No saved games yet.</p>
              ) : (
                (() => {
                  const term = librarySearch.trim().toLowerCase();
                  const shown = term
                    ? chats.filter((chat) => (chat.game || "").toLowerCase().includes(term))
                    : chats;
                  return (
                    <>
                      <div className="library-search-wrap field-clear-wrap">
                        <input
                          id="saved-library-search"
                          type="search"
                          className="library-search"
                          placeholder="Search saved games…"
                          value={librarySearch}
                          onChange={(event) => onLibrarySearchChange(event.target.value)}
                          autoComplete="off"
                          aria-label="Search saved games"
                        />
                        <ClearButton
                          show={librarySearch.length > 0}
                          onClear={() => {
                            onLibrarySearchChange("");
                            document.getElementById("saved-library-search")?.focus();
                          }}
                          label="Clear search"
                        />
                      </div>
                      {shown.length === 0 ? (
                        <p className="library-empty">No games match “{librarySearch.trim()}”.</p>
                      ) : (
                        <div className="library-grid">
                          {shown.map((chat) => (
                            <div key={chat.id} className="library-card">
                              <button
                                type="button"
                                className="library-open"
                                onClick={() => onOpenFromLibrary(chat)}
                              >
                                <CoverThumb
                                  cover={chat.cover_url ?? ""}
                                  name={chat.game}
                                  className="cover-tile"
                                />
                                <strong>{chat.game || "Untitled game"}</strong>
                                {(chat.platform || chat.release_year) && (
                                  <small>
                                    {[displayPlatform(chat.platform, chat.cover_url), chat.release_year]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </small>
                                )}
                              </button>
                              <div className="row-menu library-card-menu">
                                <button
                                  type="button"
                                  className="kebab"
                                  aria-label={`Options for ${chat.game || "Untitled game"}`}
                                  aria-expanded={menuOpenId === `lib-${chat.id}`}
                                  onClick={(event) => onToggleRowMenu(`lib-${chat.id}`, event)}
                                >
                                  <IconDotsVertical />
                                </button>
                                {menuOpenId === `lib-${chat.id}` && (
                                  <div className="row-menu-pop" role="menu">
                                    <button
                                      type="button"
                                      className="row-menu-item"
                                      onClick={() => onEditFromLibrary(chat)}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      className="row-menu-item row-menu-delete"
                                      onClick={(event) => void onDeleteChat(chat, event)}
                                    >
                                      Delete
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()
              )}
            </div>
          </div>
        </>
      )}

      <SteamLibrary
        open={steamLibraryOpen}
        onClose={onDismissOverlay}
        onPick={onPickSteamGame}
        cacheKey={steamId ?? user?.id ?? ""}
      />
    </>
  );
}
