"use client";

import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PromptDialog, usePromptDialog } from "@/app/chat/use-prompt-dialog";
import {
  PlayerMemoryGamesPanel,
  type GameMemoryRow,
} from "@/app/profile/player-memory-games-panel";
import { EditableNoteRow, EditedBadge } from "@/app/profile/player-memory-note-row";
import { ConfirmDialog, useConfirmDialog } from "@/app/use-confirm-dialog";
import {
  coercePlayerStyle,
  disablePlayerMemory,
  enablePlayerMemory,
  MEMORY_DRAFT_THRESHOLD,
  MEMORY_FULL_THRESHOLD,
  MEMORY_GAME_NOTE_CAP,
  MEMORY_STYLE_NOTE_CAP,
  MEMORY_TOGGLE_HINT,
  memoryRefreshCooldownRemainingMs,
} from "@/lib/player-memory.js";
import {
  gameMemoryPinKey,
  isStyleFieldPinned,
  isStyleNotePinned,
  readStyleRecord,
  STYLE_FIELD_KEYS,
  STYLE_FIELD_OPTIONS,
  writeStyleRecord,
} from "@/lib/player-memory-pins.js";
import type { PlayerStyleUserPins } from "@/lib/player-memory-pins.js";
import { getSupabase } from "@/lib/supabase";

type PlayerStyleShape = ReturnType<typeof coercePlayerStyle>;
type StyleFieldKey = "answerLength" | "tone" | "language" | "detailLevel";
type MemoryTab = "style" | "games";

type MemoryState = {
  message_count: number;
  tier: string;
  style: Record<string, unknown>;
  last_summarized_at: string | null;
  last_manual_refresh_at: string | null;
};

type Props = {
  session: Session | null;
  onToast?: (message: string) => void;
};

const STYLE_FIELD_LABELS: Record<StyleFieldKey, string> = {
  answerLength: "Answer length",
  tone: "Tone",
  language: "Language",
  detailLevel: "Detail",
};

const STYLE_CHIP_LABELS: Record<StyleFieldKey, Record<string, string>> = {
  answerLength: { short: "Short", medium: "Medium", detailed: "Detailed" },
  tone: { casual: "Casual", direct: "Direct" },
  language: { id: "Indonesian", en: "English", mixed: "Mixed" },
  detailLevel: { steps: "Steps", context: "Context", minimal: "Essentials" },
};

async function apiFetch(session: Session, path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...(init?.headers ?? {}),
    },
  });
}

function formatMemoryUpdated(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function memoryUpdateMeta(lastSummarized: string | null, cooldownMs: number) {
  const updated = formatMemoryUpdated(lastSummarized);
  if (!updated && cooldownMs <= 0) return "";
  const parts: string[] = [];
  if (updated) parts.push(`Updated ${updated}`);
  if (cooldownMs > 0) parts.push(`try again in ${Math.ceil(cooldownMs / 60_000)} min`);
  return parts.join(" · ");
}

function styleChipLabel(field: StyleFieldKey, value: string) {
  return STYLE_CHIP_LABELS[field][value] ?? value;
}

function styleSummary(style: PlayerStyleShape) {
  const parts = (STYLE_FIELD_KEYS as readonly StyleFieldKey[])
    .map((field) => {
      const value = style[field];
      return value ? styleChipLabel(field, value) : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : "Not set yet";
}

function PlayerMemorySkeleton() {
  return (
    <div className="player-memory-section" aria-busy="true" aria-label="Loading style memory">
      <div className="player-memory-skeleton player-memory-skeleton-header" aria-hidden />
      <div className="player-memory-skeleton player-memory-skeleton-tabs" aria-hidden />
      <div className="player-memory-skeleton player-memory-skeleton-panel" aria-hidden />
    </div>
  );
}

export function PlayerMemorySection({ session, onToast }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<MemoryState | null>(null);
  const [games, setGames] = useState<GameMemoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<MemoryTab>("style");
  const [gameFilter, setGameFilter] = useState("");
  const { confirmState, askConfirm, closeConfirm } = useConfirmDialog();
  const {
    promptState,
    promptDraft,
    setPromptDraft,
    promptInputRef,
    askPrompt,
    closePrompt,
  } = usePromptDialog();

  const load = useCallback(async () => {
    const supabase = getSupabase();
    if (!session || !supabase) {
      setEnabled(false);
      setState(null);
      setGames([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const { data: stateRow, error: stateError } = await supabase
        .from("player_memory_state")
        .select("message_count, tier, style, last_summarized_at, last_manual_refresh_at")
        .maybeSingle();
      if (stateError) throw stateError;

      if (!stateRow) {
        setEnabled(false);
        setState(null);
        setGames([]);
        return;
      }

      const { data: gameRows, error: gamesError } = await supabase
        .from("player_game_memory")
        .select("game_key, platform, progress, notes")
        .order("updated_at", { ascending: false });
      if (gamesError) throw gamesError;

      setEnabled(true);
      setState(stateRow as MemoryState);
      setGames((gameRows as GameMemoryRow[]) ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load memory.");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const persistStyle = useCallback(
    async (nextStyle: PlayerStyleShape, nextPins: PlayerStyleUserPins) => {
      if (!session || !state) return false;
      const supabase = getSupabase();
      if (!supabase) return false;
      const payload = writeStyleRecord(nextStyle, nextPins);
      const { error: updateError } = await supabase
        .from("player_memory_state")
        .update({ style: payload, updated_at: new Date().toISOString() })
        .eq("user_id", session.user.id);
      if (updateError) {
        setError(updateError.message);
        return false;
      }
      setState({ ...state, style: payload });
      return true;
    },
    [session, state],
  );

  async function setMemoryEnabled(next: boolean) {
    const supabase = getSupabase();
    if (!session || !supabase) return;
    if (!next) {
      const ok = await askConfirm("Turn off and clear what we've learned?", "Turn off");
      if (!ok) return;
    }
    setError("");
    try {
      if (next) {
        await enablePlayerMemory(supabase, session.user.id);
        onToast?.("Learning your style. Ask a few questions to get started.");
      } else {
        await disablePlayerMemory(supabase, session.user.id);
        setGames([]);
        setActiveTab("style");
        setGameFilter("");
      }
      setEnabled(next);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update setting.");
    }
  }

  async function refreshNow() {
    if (!session || refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      const res = await apiFetch(session, "/api/player-memory/refresh", { method: "POST" });
      const body = (await res.json()) as {
        error?: string;
        state?: MemoryState | null;
        skipped?: string | null;
      };
      if (!res.ok) throw new Error(body.error || "Could not update memory.");
      if (body.state) setState(body.state);
      if (body.skipped === "no_new_messages") {
        onToast?.("No new questions since the last update.");
      } else {
        onToast?.("Profile updated.");
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update memory.");
    } finally {
      setRefreshing(false);
    }
  }

  async function saveStyleField(
    field: StyleFieldKey,
    value: string,
    style: PlayerStyleShape,
    userPins: PlayerStyleUserPins,
  ) {
    const nextStyle = { ...style };
    if (value) nextStyle[field] = value;
    else delete nextStyle[field];
    const fields = new Set(userPins.fields ?? []);
    fields.add(field);
    await persistStyle(nextStyle, { ...userPins, fields: [...fields] });
  }

  async function saveStyleNote(
    index: number,
    text: string,
    style: PlayerStyleShape,
    userPins: PlayerStyleUserPins,
  ) {
    const notes = [...(style.notes ?? [])];
    notes[index] = text;
    const notePins = [...(userPins.notes ?? [])];
    while (notePins.length < notes.length) notePins.push(false);
    notePins[index] = true;
    await persistStyle({ ...style, notes }, { ...userPins, notes: notePins });
  }

  async function removeStyleNote(
    index: number,
    style: PlayerStyleShape,
    userPins: PlayerStyleUserPins,
  ) {
    const notes = [...(style.notes ?? [])];
    notes.splice(index, 1);
    const notePins = [...(userPins.notes ?? [])];
    notePins.splice(index, 1);
    await persistStyle({ ...style, notes }, { ...userPins, notes: notePins });
  }

  async function addStyleNote(style: PlayerStyleShape, userPins: PlayerStyleUserPins) {
    const notes = style.notes ?? [];
    if (notes.length >= MEMORY_STYLE_NOTE_CAP) return;
    const text = await askPrompt(
      "Add a note about how you like answers",
      "",
      "Add note",
      "e.g. Prefer numbered steps",
      200,
    );
    if (!text) return;
    const nextNotes = [...notes, text].slice(0, MEMORY_STYLE_NOTE_CAP);
    const notePins = [...(userPins.notes ?? []), true].slice(0, MEMORY_STYLE_NOTE_CAP);
    await persistStyle({ ...style, notes: nextNotes }, { ...userPins, notes: notePins });
  }

  async function saveGameProgress(
    gameKey: string,
    platform: string,
    progress: string,
    userPins: PlayerStyleUserPins,
    style: PlayerStyleShape,
  ) {
    if (!session) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const trimmed = progress.replace(/\s+/g, " ").trim().slice(0, 200);
    const { error: updateError } = await supabase
      .from("player_game_memory")
      .update({ progress: trimmed || null, updated_at: new Date().toISOString() })
      .eq("user_id", session.user.id)
      .eq("game_key", gameKey)
      .eq("platform", platform);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    const key = gameMemoryPinKey(gameKey, platform);
    const gamesPins = { ...(userPins.games ?? {}) };
    gamesPins[key] = { ...gamesPins[key], progress: true };
    await persistStyle(style, { ...userPins, games: gamesPins });
    setGames((prev) =>
      prev.map((row) =>
        row.game_key === gameKey && row.platform === platform
          ? { ...row, progress: trimmed || null }
          : row,
      ),
    );
  }

  async function saveGameNote(
    gameKey: string,
    platform: string,
    index: number,
    text: string,
    userPins: PlayerStyleUserPins,
    style: PlayerStyleShape,
  ) {
    if (!session) return;
    const row = games.find((g) => g.game_key === gameKey && g.platform === platform);
    if (!row) return;
    const notes = [...(row.notes ?? [])];
    notes[index] = text;
    const supabase = getSupabase();
    if (!supabase) return;
    const { error: updateError } = await supabase
      .from("player_game_memory")
      .update({ notes, updated_at: new Date().toISOString() })
      .eq("user_id", session.user.id)
      .eq("game_key", gameKey)
      .eq("platform", platform);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    const key = gameMemoryPinKey(gameKey, platform);
    const gamesPins = { ...(userPins.games ?? {}) };
    const notePins = [...(gamesPins[key]?.notes ?? [])];
    while (notePins.length < notes.length) notePins.push(false);
    notePins[index] = true;
    gamesPins[key] = { ...gamesPins[key], notes: notePins };
    await persistStyle(style, { ...userPins, games: gamesPins });
    setGames((prev) =>
      prev.map((g) => (g.game_key === gameKey && g.platform === platform ? { ...g, notes } : g)),
    );
  }

  async function removeGameNote(
    gameKey: string,
    platform: string,
    index: number,
    userPins: PlayerStyleUserPins,
    style: PlayerStyleShape,
  ) {
    if (!session) return;
    const row = games.find((g) => g.game_key === gameKey && g.platform === platform);
    if (!row) return;
    const notes = [...(row.notes ?? [])];
    notes.splice(index, 1);
    const supabase = getSupabase();
    if (!supabase) return;
    const { error: updateError } = await supabase
      .from("player_game_memory")
      .update({ notes, updated_at: new Date().toISOString() })
      .eq("user_id", session.user.id)
      .eq("game_key", gameKey)
      .eq("platform", platform);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    const key = gameMemoryPinKey(gameKey, platform);
    const gamesPins = { ...(userPins.games ?? {}) };
    const notePins = [...(gamesPins[key]?.notes ?? [])];
    notePins.splice(index, 1);
    if (notePins.some(Boolean) || gamesPins[key]?.progress) {
      gamesPins[key] = { ...gamesPins[key], notes: notePins };
    } else {
      delete gamesPins[key];
    }
    await persistStyle(style, { ...userPins, games: gamesPins });
    setGames((prev) =>
      prev.map((g) => (g.game_key === gameKey && g.platform === platform ? { ...g, notes } : g)),
    );
  }

  async function addGameNote(
    gameKey: string,
    platform: string,
    userPins: PlayerStyleUserPins,
    style: PlayerStyleShape,
  ) {
    const row = games.find((g) => g.game_key === gameKey && g.platform === platform);
    if (!row || (row.notes?.length ?? 0) >= MEMORY_GAME_NOTE_CAP) return;
    const text = await askPrompt(
      "Add a note for this game",
      "",
      "Add note",
      "e.g. Stuck on the fire boss",
      200,
    );
    if (!text) return;
    const notes = [...(row.notes ?? []), text].slice(0, MEMORY_GAME_NOTE_CAP);
    if (!session) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const { error: updateError } = await supabase
      .from("player_game_memory")
      .update({ notes, updated_at: new Date().toISOString() })
      .eq("user_id", session.user.id)
      .eq("game_key", gameKey)
      .eq("platform", platform);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    const key = gameMemoryPinKey(gameKey, platform);
    const gamesPins = { ...(userPins.games ?? {}) };
    const notePins = [...(gamesPins[key]?.notes ?? []), true].slice(0, MEMORY_GAME_NOTE_CAP);
    gamesPins[key] = { ...gamesPins[key], notes: notePins };
    await persistStyle(style, { ...userPins, games: gamesPins });
    setGames((prev) =>
      prev.map((g) => (g.game_key === gameKey && g.platform === platform ? { ...g, notes } : g)),
    );
  }

  async function clearCards() {
    if (!session) return;
    const ok = await askConfirm(
      "Clear your style memory? Your question count will stay.",
      "Clear",
    );
    if (!ok) return;
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.from("player_game_memory").delete().eq("user_id", session.user.id);
    await supabase
      .from("player_memory_state")
      .update({
        style: {},
        last_summarized_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", session.user.id);
    await load();
    onToast?.("Style memory cleared.");
  }

  const activeGames = useMemo(
    () =>
      games.filter((row) => (row.notes?.length ?? 0) > 0 || Boolean(row.progress?.trim())),
    [games],
  );

  const filteredGames = useMemo(() => {
    const query = gameFilter.replace(/\s+/g, " ").trim().toLowerCase();
    if (!query) return activeGames;
    return activeGames.filter((row) => {
      const title = `${row.game_key.replace(/-/g, " ")} ${row.platform}`.toLowerCase();
      return title.includes(query);
    });
  }, [activeGames, gameFilter]);

  if (!session) return null;
  if (loading) return <PlayerMemorySkeleton />;

  const count = state?.message_count ?? 0;
  const tier = state?.tier ?? "collecting";
  const { style, userPins } = readStyleRecord(state?.style);
  const customNotes = style.notes ?? [];
  const cooldownMs = memoryRefreshCooldownRemainingMs(state?.last_manual_refresh_at ?? null);
  const canRefresh = enabled && count >= MEMORY_DRAFT_THRESHOLD && cooldownMs === 0;
  const progressPct = Math.min(100, Math.round((count / MEMORY_FULL_THRESHOLD) * 100));
  const draftLabel = tier === "draft" ? " (draft)" : "";
  const showMemoryEditor = enabled && count >= MEMORY_DRAFT_THRESHOLD;
  const updateMeta = memoryUpdateMeta(state?.last_summarized_at ?? null, cooldownMs);
  const canAddStyleNote = customNotes.length < MEMORY_STYLE_NOTE_CAP;
  const statusLine = enabled
    ? count >= MEMORY_FULL_THRESHOLD
      ? "Active · updates daily"
      : `${count} of ${MEMORY_FULL_THRESHOLD} questions logged`
    : MEMORY_TOGGLE_HINT;

  return (
    <div className="player-memory-section">
      <div className="player-memory-header">
        <div className="player-memory-header-row">
          <div className="player-memory-header-copy">
            <p className="player-memory-status">{statusLine}</p>
            {enabled && count < MEMORY_FULL_THRESHOLD ? (
              <div className="player-memory-progress" aria-hidden="true">
                <div className="player-memory-progress-bar">
                  <div className="player-memory-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                <span className="player-memory-progress-label">
                  {count} / {MEMORY_FULL_THRESHOLD}
                </span>
              </div>
            ) : null}
          </div>
          <label className="memory-switch">
            <span className="memory-switch-label">{enabled ? "On" : "Off"}</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => void setMemoryEnabled(event.target.checked)}
              aria-label="Learn my style"
            />
          </label>
        </div>

        {enabled && count >= MEMORY_DRAFT_THRESHOLD ? (
          <div className="player-memory-header-actions">
            <button
              type="button"
              className="nav-button player-memory-update-btn"
              disabled={!canRefresh || refreshing}
              onClick={() => void refreshNow()}
            >
              {refreshing ? "Updating…" : "Update now"}
            </button>
            {updateMeta ? <p className="player-memory-meta">{updateMeta}</p> : null}
          </div>
        ) : null}
      </div>

      {enabled && count < MEMORY_DRAFT_THRESHOLD ? (
        <p className="profile-hint player-memory-collecting-hint">
          Still learning. Memory kicks in after {MEMORY_DRAFT_THRESHOLD} questions ({count}/
          {MEMORY_DRAFT_THRESHOLD}).
        </p>
      ) : null}

      {showMemoryEditor ? (
        <>
          <div className="player-memory-tabs" role="tablist" aria-label="Memory sections">
            <button
              type="button"
              role="tab"
              id="player-memory-tab-style"
              aria-selected={activeTab === "style"}
              aria-controls="player-memory-panel-style"
              className={`player-memory-tab${activeTab === "style" ? " is-active" : ""}`}
              onClick={() => setActiveTab("style")}
            >
              Style
            </button>
            <button
              type="button"
              role="tab"
              id="player-memory-tab-games"
              aria-selected={activeTab === "games"}
              aria-controls="player-memory-panel-games"
              className={`player-memory-tab${activeTab === "games" ? " is-active" : ""}`}
              onClick={() => setActiveTab("games")}
            >
              Games ({activeGames.length})
            </button>
          </div>

          {activeTab === "style" ? (
            <div
              id="player-memory-panel-style"
              role="tabpanel"
              aria-labelledby="player-memory-tab-style"
              className="player-memory-body"
            >
              <details className="player-memory-panel">
                <summary className="player-memory-panel-summary">
                  <span className="player-memory-panel-title">Answer style{draftLabel}</span>
                  <span className="player-memory-summary-text">{styleSummary(style)}</span>
                </summary>
                <div className="player-memory-panel-body">
                  <p className="player-memory-panel-hint">
                    Pick your defaults or run Update now to refresh from chats. Your edits stay put.
                  </p>
                  <div className="player-memory-chips" aria-label="Current style summary">
                    {(STYLE_FIELD_KEYS as readonly StyleFieldKey[]).map((field) => {
                      const value = style[field];
                      if (!value) return null;
                      return (
                        <span key={field} className="player-memory-chip">
                          {styleChipLabel(field, value)}
                        </span>
                      );
                    })}
                  </div>
                  <div className="player-memory-prefs-grid">
                    {(STYLE_FIELD_KEYS as readonly StyleFieldKey[]).map((field) => (
                      <label key={field} className="player-memory-pref-field">
                        <span className="player-memory-pref-label">
                          {STYLE_FIELD_LABELS[field]}
                          {isStyleFieldPinned(userPins, field) ? <EditedBadge /> : null}
                        </span>
                        <select
                          className="player-memory-pref-select"
                          value={style[field] ?? ""}
                          onChange={(event) =>
                            void saveStyleField(field, event.target.value, style, userPins)
                          }
                        >
                          {STYLE_FIELD_OPTIONS[field].map((option) => (
                            <option key={option.value || "unset"} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
              </details>

              <section className="player-memory-panel player-memory-panel--static">
                <div className="player-memory-panel-head">
                  <h2 className="player-memory-panel-title">
                    Learned notes ({customNotes.length}/{MEMORY_STYLE_NOTE_CAP})
                  </h2>
                  {canAddStyleNote ? (
                    <button
                      type="button"
                      className="player-memory-text-btn"
                      onClick={() => void addStyleNote(style, userPins)}
                    >
                      Add note
                    </button>
                  ) : null}
                </div>
                <p className="player-memory-panel-hint">
                  Edit inline or remove with ×. Your edits stay put on Update now.
                </p>
                {customNotes.length > 0 ? (
                  <ul className="player-memory-list">
                    {customNotes.map((line, index) => (
                      <EditableNoteRow
                        key={`${line}-${index}`}
                        value={line}
                        pinned={isStyleNotePinned(userPins, index)}
                        onSave={(next) => void saveStyleNote(index, next, style, userPins)}
                        onRemove={() => void removeStyleNote(index, style, userPins)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="player-memory-empty">
                    No notes yet. Ask a few questions or run Update now.
                  </p>
                )}
              </section>
            </div>
          ) : (
            <PlayerMemoryGamesPanel
              activeGames={activeGames}
              filteredGames={filteredGames}
              gameFilter={gameFilter}
              onGameFilterChange={setGameFilter}
              userPins={userPins}
              onSaveProgress={(gameKey, platform, progress) =>
                void saveGameProgress(gameKey, platform, progress, userPins, style)
              }
              onAddNote={(gameKey, platform) =>
                void addGameNote(gameKey, platform, userPins, style)
              }
              onSaveNote={(gameKey, platform, index, text) =>
                void saveGameNote(gameKey, platform, index, text, userPins, style)
              }
              onRemoveNote={(gameKey, platform, index) =>
                void removeGameNote(gameKey, platform, index, userPins, style)
              }
            />
          )}

          <div className="player-memory-danger-zone">
            <button type="button" className="player-memory-clear-btn" onClick={() => void clearCards()}>
              Clear style memory
            </button>
          </div>
        </>
      ) : null}

      {error ? <p className="profile-error">{error}</p> : null}

      <ConfirmDialog
        state={confirmState}
        onCancel={() => closeConfirm(false)}
        onConfirm={() => closeConfirm(true)}
      />

      {promptState ? (
        <PromptDialog
          label={promptState.label}
          confirmLabel={promptState.confirmLabel}
          placeholder={promptState.placeholder}
          maxLength={promptState.maxLength}
          draft={promptDraft}
          inputRef={promptInputRef}
          onDraftChange={setPromptDraft}
          onCancel={() => closePrompt(null)}
          onSave={() => {
            const trimmed = promptDraft.replace(/\s+/g, " ").trim();
            closePrompt(trimmed || null);
          }}
        />
      ) : null}
    </div>
  );
}
