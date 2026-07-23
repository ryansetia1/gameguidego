"use client";

import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";

import {
  coercePlayerStyle,
  MEMORY_DRAFT_THRESHOLD,
  MEMORY_FULL_THRESHOLD,
  MEMORY_TOGGLE_HINT,
  MEMORY_TOGGLE_LABEL,
  memoryRefreshCooldownRemainingMs,
  styleBulletsForPrompt,
} from "@/lib/player-memory.js";
import { getSupabase } from "@/lib/supabase";

type MemoryState = {
  message_count: number;
  tier: string;
  style: Record<string, unknown>;
  last_summarized_at: string | null;
  last_manual_refresh_at: string | null;
};

type GameMemoryRow = {
  game_key: string;
  platform: string;
  progress: string | null;
  notes: string[];
};

type Props = {
  session: Session | null;
  onToast?: (message: string) => void;
};

async function apiFetch(
  session: Session,
  path: string,
  init?: RequestInit,
) {
  return fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...(init?.headers ?? {}),
    },
  });
}

function formatRelativeTime(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function PlayerMemorySection({ session, onToast }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<MemoryState | null>(null);
  const [games, setGames] = useState<GameMemoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!session) {
      setEnabled(false);
      setState(null);
      setGames([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch(session, "/api/player-memory");
      const body = (await res.json()) as {
        enabled?: boolean;
        state?: MemoryState | null;
        games?: GameMemoryRow[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || "Could not load memory.");
      setEnabled(Boolean(body.enabled));
      setState(body.state ?? null);
      setGames(body.games ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load memory.");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setMemoryEnabled(next: boolean) {
    if (!session) return;
    if (!next) {
      const ok = window.confirm("Turn off and clear what we've learned?");
      if (!ok) return;
    }
    setError("");
    try {
      const res = await apiFetch(session, "/api/player-memory", {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
      const body = (await res.json()) as { error?: string; state?: MemoryState | null };
      if (!res.ok) throw new Error(body.error || "Could not update setting.");
      setEnabled(next);
      setState(body.state ?? null);
      if (!next) setGames([]);
      if (next) onToast?.("Learning your style. Ask a few questions to get started.");
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

  async function removeStyleNote(index: number) {
    if (!session || !state) return;
    const style = coercePlayerStyle(state.style);
    const notes = [...(style.notes ?? [])];
    notes.splice(index, 1);
    const supabase = getSupabase();
    if (!supabase) return;
    const { error: updateError } = await supabase
      .from("player_memory_state")
      .update({ style: { ...style, notes }, updated_at: new Date().toISOString() })
      .eq("user_id", session.user.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setState({ ...state, style: { ...style, notes } });
  }

  async function removeGameNote(gameKey: string, platform: string, index: number) {
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
    setGames((prev) =>
      prev.map((g) =>
        g.game_key === gameKey && g.platform === platform ? { ...g, notes } : g,
      ),
    );
  }

  async function clearCards() {
    if (!session) return;
    const ok = window.confirm("Clear your style memory? Your question count will stay.");
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

  if (!session || loading) return null;

  const count = state?.message_count ?? 0;
  const tier = state?.tier ?? "collecting";
  const style = coercePlayerStyle(state?.style);
  const customNotes = style.notes ?? [];
  const inferredBullets = styleBulletsForPrompt({ ...style, notes: [] });
  const cooldownMs = memoryRefreshCooldownRemainingMs(state?.last_manual_refresh_at ?? null);
  const canRefresh = enabled && count >= MEMORY_DRAFT_THRESHOLD && cooldownMs === 0;
  const progressPct = Math.min(100, Math.round((count / MEMORY_FULL_THRESHOLD) * 100));
  const draftLabel = tier === "draft" ? " (draft)" : "";

  return (
    <div className="field player-memory-section">
      <div className="profile-menu-toggle player-memory-toggle">
        <span className="field-label">{MEMORY_TOGGLE_LABEL}</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => void setMemoryEnabled(event.target.checked)}
          aria-label={MEMORY_TOGGLE_LABEL}
        />
      </div>
      <p className="field-hint">
        {enabled
          ? count < MEMORY_FULL_THRESHOLD
            ? `${count} of ${MEMORY_FULL_THRESHOLD} questions logged.`
            : "Style memory active. Updates daily."
          : MEMORY_TOGGLE_HINT}
      </p>

      {enabled && count < MEMORY_FULL_THRESHOLD && (
        <div className="player-memory-progress" aria-hidden="true">
          <div className="player-memory-progress-bar">
            <div className="player-memory-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="player-memory-progress-label">
            {count} / {MEMORY_FULL_THRESHOLD}
          </span>
        </div>
      )}

      {enabled && count < MEMORY_DRAFT_THRESHOLD && (
        <p className="profile-hint">
          Still learning. This kicks in after {MEMORY_FULL_THRESHOLD} questions across your chats.
        </p>
      )}

      {enabled && count >= MEMORY_DRAFT_THRESHOLD && (inferredBullets.length > 0 || customNotes.length > 0) && (
        <div className="player-memory-card">
          <h2 className="player-memory-card-title">Your play style{draftLabel}</h2>
          {inferredBullets.length > 0 && (
            <ul className="player-memory-list">
              {inferredBullets.map((line) => (
                <li key={line} className="player-memory-row">
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
          {customNotes.length > 0 && (
            <ul className="player-memory-list">
              {customNotes.map((line, index) => (
                <li key={`${line}-${index}`} className="player-memory-row">
                  <span>{line}</span>
                  <button
                    type="button"
                    className="player-memory-remove"
                    onClick={() => void removeStyleNote(index)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {enabled && games.length > 0 && (
        <div className="player-memory-card">
          <h2 className="player-memory-card-title">Game notes{draftLabel}</h2>
          {games.map((row) => (
            <div key={`${row.game_key}:${row.platform}`} className="player-memory-game">
              <p className="player-memory-game-title">
                {row.game_key.replace(/\b\w/g, (char) => char.toUpperCase())}
                {row.platform ? ` · ${row.platform}` : ""}
              </p>
              {row.progress && <p className="profile-hint">{row.progress}</p>}
              {row.notes?.length > 0 && (
                <ul className="player-memory-list">
                  {row.notes.map((note, index) => (
                    <li key={`${note}-${index}`} className="player-memory-row">
                      <span>{note}</span>
                      <button
                        type="button"
                        className="player-memory-remove"
                        onClick={() => void removeGameNote(row.game_key, row.platform, index)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {enabled && (
        <div className="player-memory-actions">
          <button
            type="button"
            className="nav-button"
            disabled={!canRefresh || refreshing}
            onClick={() => void refreshNow()}
          >
            {refreshing ? "Updating…" : "Update now"}
          </button>
          {count < MEMORY_DRAFT_THRESHOLD && (
            <p className="profile-hint">
              Needs {MEMORY_DRAFT_THRESHOLD} questions first ({count}/{MEMORY_DRAFT_THRESHOLD})
            </p>
          )}
          {cooldownMs > 0 && (
            <p className="profile-hint">
              Updated recently. Try again in {Math.ceil(cooldownMs / 60_000)} min.
            </p>
          )}
          {state?.last_summarized_at && (
            <p className="profile-hint">Last updated: {formatRelativeTime(state.last_summarized_at)}</p>
          )}
          {count >= MEMORY_DRAFT_THRESHOLD && (
            <button type="button" className="player-memory-clear" onClick={() => void clearCards()}>
              Clear style memory
            </button>
          )}
        </div>
      )}

      {error && <p className="profile-error">{error}</p>}
    </div>
  );
}
