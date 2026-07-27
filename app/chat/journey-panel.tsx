"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";

import { IconChevronDown, IconRefresh } from "@/app/icons";
import {
  JOURNEY_ADD_LABEL,
  JOURNEY_EDIT_LABEL,
  JOURNEY_EMPTY_HINT,
  JOURNEY_UPDATE_LABEL,
  isLongJournalBody,
  journalBodyPreview,
} from "@/lib/player-journey.js";
import { journeyAuthedFetch } from "@/lib/player-journey-client.js";

type Props = {
  user: User | null;
  game: string;
  platform: string;
  catalogGameId?: number | null;
  journeyEnabled: boolean;
  readOnly?: boolean;
  loading: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  onToast?: (message: string) => void;
};

function formatUpdated(iso: string | null) {
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

export function JourneyPanel({
  user,
  game,
  platform,
  catalogGameId = null,
  journeyEnabled,
  loading,
  expanded = false,
  onExpandedChange,
  onToast,
  readOnly = false,
}: Props) {
  const [open, setOpen] = useState(expanded);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [updatingAt, setUpdatingAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [canManualUpdate, setCanManualUpdate] = useState(false);

  const load = useCallback(async () => {
    if (!user || !game.trim() || (!journeyEnabled && !readOnly)) {
      setBody("");
      setDraft("");
      setLastUpdatedAt(null);
      setUpdatingAt(null);
      setCanManualUpdate(false);
      setLoadState("idle");
      return;
    }
    setLoadState("loading");
    try {
      const params = new URLSearchParams({ game, platform: platform || "" });
      if (catalogGameId != null && Number.isFinite(catalogGameId)) {
        params.set("catalogGameId", String(Math.floor(catalogGameId)));
      }
      const response = await journeyAuthedFetch(`/api/player-journey?${params}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load journal.");
      const nextBody = typeof payload.body === "string" ? payload.body : "";
      setBody(nextBody);
      setDraft(nextBody);
      setLastUpdatedAt(typeof payload.lastUpdatedAt === "string" ? payload.lastUpdatedAt : null);
      setUpdatingAt(typeof payload.updatingAt === "string" ? payload.updatingAt : null);
      setCanManualUpdate(payload.canManualUpdate === true);
      setLoadState("idle");
    } catch {
      setLoadState("error");
    }
  }, [user, journeyEnabled, readOnly, game, platform, catalogGameId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setOpen(expanded);
  }, [expanded]);

  function setPanelOpen(next: boolean) {
    setOpen(next);
    onExpandedChange?.(next);
  }

  if (!user || !game.trim() || (!journeyEnabled && !readOnly)) return null;

  const isUpdating = Boolean(updatingAt) || busy;
  const updatedLabel = formatUpdated(lastUpdatedAt);
  const trimmedBody = body.trim();
  const hasBody = Boolean(trimmedBody);
  const isLongBody = hasBody && isLongJournalBody(trimmedBody);
  const summaryPreview = hasBody ? journalBodyPreview(trimmedBody) : "";
  const journalActionLabel = hasBody ? JOURNEY_EDIT_LABEL : JOURNEY_ADD_LABEL;

  async function handleUpdate() {
    if (!user || isUpdating) return;
    setBusy(true);
    try {
      const response = await journeyAuthedFetch("/api/player-journey/update", {
        method: "POST",
        body: JSON.stringify({ game, platform, catalogGameId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not update journal.");
      if (typeof payload.summary === "string" && payload.summary.trim()) {
        onToast?.(payload.summary.trim());
      }
      await load();
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : "Could not update journal.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit() {
    if (!user || isUpdating) return;
    setBusy(true);
    try {
      const response = await journeyAuthedFetch("/api/player-journey", {
        method: "PATCH",
        body: JSON.stringify({ game, platform, body: draft, catalogGameId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save journal.");
      if (typeof payload.summary === "string" && payload.summary.trim()) {
        onToast?.(payload.summary.trim());
      }
      setEditing(false);
      await load();
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : "Could not save journal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className="journey-panel sources game-card-guides-hidden"
      open={open}
      onToggle={(event) => {
        setPanelOpen((event.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary className="game-card-guides-summary journey-panel-summary">
        <span className="game-card-guides-summary-label">
          Your journal
          {!open && summaryPreview ? (
            <span className="journey-panel-summary-preview">{summaryPreview}</span>
          ) : null}
        </span>
        {isUpdating ? (
          <span className="guide-status-chip is-pending" aria-live="polite">
            Updating…
          </span>
        ) : null}
        <span className="chevron-toggle" aria-hidden>
          <IconChevronDown size={14} />
        </span>
      </summary>
      <div className="journey-panel-body">
        {loadState === "loading" ? (
          <p className="journey-panel-hint" aria-busy="true">
            Loading journal…
          </p>
        ) : loadState === "error" ? (
          <p className="journey-panel-hint">Could not load your journal.</p>
        ) : editing ? (
          <>
            <textarea
              className="journey-panel-edit"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={6}
              disabled={isUpdating || loading}
              aria-label={hasBody ? "Edit your journal" : "Add your journal"}
            />
            <div className="journey-panel-actions journey-panel-actions--edit">
              <button
                type="button"
                className="nav-button journey-panel-edit-btn"
                disabled={isUpdating || loading}
                onClick={() => {
                  setDraft(body);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="nav-button journey-panel-update-btn"
                disabled={isUpdating || loading}
                onClick={() => void handleSaveEdit()}
              >
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            <p
              className={`journey-panel-text${hasBody ? "" : " is-empty"}${isLongBody ? " is-scrollable" : ""}`}
            >
              {hasBody ? trimmedBody : JOURNEY_EMPTY_HINT}
            </p>
            <div className="journey-panel-footer">
              {updatedLabel ? (
                <p className="journey-panel-meta">Updated {updatedLabel}</p>
              ) : null}
              {!readOnly ? (
                <div className="journey-panel-actions">
                  <button
                    type="button"
                    className="nav-button journey-panel-edit-btn"
                    disabled={isUpdating || loading}
                    onClick={() => setEditing(true)}
                  >
                    {journalActionLabel}
                  </button>
                  <button
                    type="button"
                    className="nav-button journey-panel-update-btn"
                    disabled={isUpdating || loading || !canManualUpdate}
                    title={
                      canManualUpdate
                        ? undefined
                        : hasBody
                          ? "No new chat messages to pull in yet"
                          : "Share progress in chat first"
                    }
                    aria-label={
                      canManualUpdate
                        ? JOURNEY_UPDATE_LABEL
                        : hasBody
                          ? "Update journal (no new chat messages)"
                          : "Update journal (share progress in chat first)"
                    }
                    onClick={() => void handleUpdate()}
                  >
                    <IconRefresh size={14} className={isUpdating ? "spin" : ""} aria-hidden />
                    {JOURNEY_UPDATE_LABEL}
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
