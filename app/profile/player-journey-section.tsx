"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";

import { JourneyPanel } from "@/app/chat/journey-panel";
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
  const [rows, setRows] = useState<JourneyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState("");

  const load = useCallback(async () => {
    if (!user || !journeyEnabled) {
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
  }, [user, journeyEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user) return null;
  if (!journeyEnabled) {
    return (
      <p className="profile-hint">
        Turn on Track my progress in the profile menu to keep per-game journals.
      </p>
    );
  }
  if (loading) return <p className="profile-hint">Loading journals…</p>;
  if (!rows.length) {
    return (
      <p className="profile-hint">
        No journals yet. Share progress in a game chat and your journal will start here.
      </p>
    );
  }

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
              onClick={() => setOpenKey(expanded ? "" : key)}
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
