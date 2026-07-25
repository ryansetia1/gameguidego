"use client";

import { ClearButton } from "@/app/clear-button";
import { EditableNoteRow, EditedBadge } from "@/app/profile/player-memory-note-row";
import { gameRoomKey } from "@/lib/game-room.js";
import { MEMORY_GAME_NOTE_CAP } from "@/lib/player-memory.js";
import { isGameNotePinned, isGameProgressPinned } from "@/lib/player-memory-pins.js";
import type { PlayerStyleUserPins } from "@/lib/player-memory-pins.js";

export type GameMemoryRow = {
  game_key: string;
  platform: string;
  progress: string | null;
  notes: string[];
};

const GAME_SEARCH_THRESHOLD = 5;

function formatGameKey(key: string) {
  return key.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

type Props = {
  activeGames: GameMemoryRow[];
  filteredGames: GameMemoryRow[];
  gameFilter: string;
  onGameFilterChange: (value: string) => void;
  userPins: PlayerStyleUserPins;
  libraryRoomKeys: Set<string>;
  onSaveProgress: (gameKey: string, platform: string, progress: string) => void;
  onAddNote: (gameKey: string, platform: string) => void;
  onSaveNote: (gameKey: string, platform: string, index: number, text: string) => void;
  onRemoveNote: (gameKey: string, platform: string, index: number) => void;
  onForgetGame: (gameKey: string, platform: string, title: string) => void;
};

export function PlayerMemoryGamesPanel({
  activeGames,
  filteredGames,
  gameFilter,
  onGameFilterChange,
  userPins,
  libraryRoomKeys,
  onSaveProgress,
  onAddNote,
  onSaveNote,
  onRemoveNote,
  onForgetGame,
}: Props) {
  return (
    <div
      id="player-memory-panel-games"
      role="tabpanel"
      aria-labelledby="player-memory-tab-games"
      className="player-memory-body"
    >
      {activeGames.length >= GAME_SEARCH_THRESHOLD ? (
        <label className="player-memory-search-field">
          <span className="player-memory-pref-label">Search games</span>
          <div className="field-clear-wrap">
            <input
              type="search"
              className="player-memory-search"
              value={gameFilter}
              placeholder="Filter by game or platform"
              onChange={(event) => onGameFilterChange(event.target.value)}
              autoComplete="off"
            />
            <ClearButton
              show={gameFilter.length > 0}
              onClear={() => onGameFilterChange("")}
              label="Clear game search"
            />
          </div>
        </label>
      ) : null}

      {activeGames.length === 0 ? (
        <p className="player-memory-empty player-memory-empty--games">
          No game notes yet. Ask about a game and we&apos;ll remember progress here.
        </p>
      ) : filteredGames.length === 0 ? (
        <p className="player-memory-empty">No games match your search.</p>
      ) : (
        filteredGames.map((row) => {
          const notes = row.notes ?? [];
          const title = `${formatGameKey(row.game_key)}${row.platform ? ` · ${row.platform}` : ""}`;
          const progressPinned = isGameProgressPinned(userPins, row.game_key, row.platform);
          const notInLibrary = !libraryRoomKeys.has(gameRoomKey(row.game_key, row.platform));
          return (
            <details key={`${row.game_key}:${row.platform}`} className="player-memory-game">
              <summary className="player-memory-game-summary" aria-label={title}>
                <span className="player-memory-game-summary-leading" aria-hidden="true" />
                <span className="player-memory-game-summary-body">
                  <span className="player-memory-game-title">{title}</span>
                  {notInLibrary ? (
                    <span className="player-memory-not-in-library">Not in library</span>
                  ) : null}
                </span>
                <span className="player-memory-game-count" aria-label={`${notes.length} notes`}>
                  {notes.length}
                </span>
              </summary>
              <div className="player-memory-game-body">
                <label className="player-memory-progress-field">
                  <span className="player-memory-pref-label">
                    Progress
                    {progressPinned ? <EditedBadge /> : null}
                  </span>
                  <input
                    type="text"
                    className="player-memory-note-input"
                    defaultValue={row.progress ?? ""}
                    placeholder="e.g. Chapter 2"
                    onBlur={(event) => {
                      const next = event.target.value.replace(/\s+/g, " ").trim();
                      if (next !== (row.progress ?? "").trim()) {
                        onSaveProgress(row.game_key, row.platform, next);
                      }
                    }}
                  />
                </label>
                <div className="player-memory-subblock-head player-memory-subblock-head--tight">
                  <span className="player-memory-pref-label">Notes</span>
                  {notes.length < MEMORY_GAME_NOTE_CAP ? (
                    <button
                      type="button"
                      className="player-memory-text-btn"
                      onClick={() => onAddNote(row.game_key, row.platform)}
                    >
                      Add note
                    </button>
                  ) : null}
                </div>
                {notes.length > 0 ? (
                  <ul className="player-memory-list">
                    {notes.map((note, index) => (
                      <EditableNoteRow
                        key={`${note}-${index}`}
                        value={note}
                        pinned={isGameNotePinned(userPins, row.game_key, row.platform, index)}
                        onSave={(next) => onSaveNote(row.game_key, row.platform, index, next)}
                        onRemove={() => onRemoveNote(row.game_key, row.platform, index)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="player-memory-empty">No notes for this game yet.</p>
                )}
                <div className="player-memory-game-forget">
                  <button
                    type="button"
                    className="player-memory-forget-btn"
                    onClick={() => onForgetGame(row.game_key, row.platform, title)}
                  >
                    Forget this game
                  </button>
                </div>
              </div>
            </details>
          );
        })
      )}
    </div>
  );
}
