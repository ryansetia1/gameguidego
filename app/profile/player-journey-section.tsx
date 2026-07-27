"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog, useConfirmDialog } from "@/app/use-confirm-dialog";
import { JourneyPanel } from "@/app/chat/journey-panel";
import {
  JOURNEY_CLEAR_ALL_CONFIRM,
  JOURNEY_PAUSED_HINT,
} from "@/lib/player-journey.js";
import { journeyAuthedFetch } from "@/lib/player-journey-client.js";

type JourneyRow = {
  gameKey: string;
  platform: string;
  catalogGameId: number | null;
  bodyChars: number;
  lastUpdatedAt: string | null;
};

type Props = {
  user: User | null;
  journeyEnabled: boolean;
  onToast?: (message: string) => void;
};

function gameLabel(gameKey: string) {
  return gameKey.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function PlayerJourneySection({ user, journeyEnabled, onToast }: Props) {
  const { confirmState, askConfirm, closeConfirm } = useConfirmDialog();
  const [rows, setRows] = useState<JourneyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState("");
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await journeyAuthedFetch("/api/player-journey/list");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load journals.");
      setRows(Array.isArray(payload.journeys) ? payload.journeys : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load, journeyEnabled]);

  async function clearAll() {
    if (!user || clearing || !rows.length) return;
    const ok = await askConfirm(JOURNEY_CLEAR_ALL_CONFIRM, "Clear all");
    if (!ok) return;
    setClearing(true);
    try {
      const response = await journeyAuthedFetch("/api/player-journey/clear", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not clear journals.");
      setOpenKey("");
      await load();
      onToast?.("All progress journals cleared.");
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : "Could not clear journals.");
    } finally {
      setClearing(false);
    }
  }

  if (!user) return null;
  if (loading) return <p className="profile-hint">Loading journals…</p>;

  if (!journeyEnabled) {
    if (!rows.length) {
      return (
        <p className="profile-hint">
          Turn on Track my progress in the profile menu to keep per-game journals.
        </p>
      );
    }
    return (
      <>
        <p className="profile-hint">{JOURNEY_PAUSED_HINT}</p>
        <JourneyRowList
          rows={rows}
          user={user}
          journeyEnabled={false}
          openKey={openKey}
          onOpenKeyChange={setOpenKey}
          onToast={onToast}
        />
        <div className="player-memory-danger-zone">
          <button
            type="button"
            className="player-memory-clear-btn"
            disabled={clearing}
            onClick={() => void clearAll()}
          >
            Clear all journals
          </button>
        </div>
        <ConfirmDialog
          state={confirmState}
          onCancel={() => closeConfirm(false)}
          onConfirm={() => closeConfirm(true)}
        />
      </>
    );
  }

  if (!rows.length) {
    return (
      <p className="profile-hint">
        No journals yet. Share progress in a game chat and your journal will start here.
      </p>
    );
  }

  return (
    <>
      <JourneyRowList
        rows={rows}
        user={user}
        journeyEnabled
        openKey={openKey}
        onOpenKeyChange={setOpenKey}
        onToast={onToast}
      />
      <div className="player-memory-danger-zone">
        <button
          type="button"
          className="player-memory-clear-btn"
          disabled={clearing}
          onClick={() => void clearAll()}
        >
          Clear all journals
        </button>
      </div>
      <ConfirmDialog
        state={confirmState}
        onCancel={() => closeConfirm(false)}
        onConfirm={() => closeConfirm(true)}
      />
    </>
  );
}

function JourneyRowList({
  rows,
  user,
  journeyEnabled,
  openKey,
  onOpenKeyChange,
  onToast,
}: {
  rows: JourneyRow[];
  user: User;
  journeyEnabled: boolean;
  openKey: string;
  onOpenKeyChange: (key: string) => void;
  onToast?: (message: string) => void;
}) {
  return (
    <div className="player-journey-section">
      {rows.map((row) => {
        const key = `${row.gameKey}::${row.platform}`;
        const game = gameLabel(row.gameKey);
        const expanded = openKey === key;
        return (
          <div key={key} className="player-journey-row">
            <button
              type="button"
              className="player-journey-row-head"
              onClick={() => onOpenKeyChange(expanded ? "" : key)}
            >
              <span>
                {game}
                {row.platform ? ` · ${row.platform}` : ""}
              </span>
              <span className="player-journey-row-meta">
                {row.bodyChars > 0 ? `${row.bodyChars} chars` : "Empty"}
              </span>
            </button>
            {expanded ? (
              <JourneyPanel
                user={user}
                game={row.gameKey}
                platform={row.platform}
                catalogGameId={row.catalogGameId}
                journeyEnabled={journeyEnabled}
                readOnly={!journeyEnabled}
                loading={false}
                expanded
                onToast={onToast}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
