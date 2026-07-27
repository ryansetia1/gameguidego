"use client";

import type { User } from "@supabase/supabase-js";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { IconChevronRight } from "@/app/icons";
import {
  JOURNEY_TOGGLE_HINT,
  JOURNEY_TOGGLE_LABEL,
  playerJourneyEnabledFromMetadata,
} from "@/lib/player-journey.js";
import { journeyEnabledFromUserMetadata } from "@/lib/player-journey-prefs.js";
import { journeyAuthedFetch } from "@/lib/player-journey-client.js";

type Props = {
  user: User | null;
};

export function PlayerJourneyLink({ user }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setEnabled(false);
      setCount(0);
      setLoadError(false);
      setLoading(false);
      return;
    }
    const remote = journeyEnabledFromUserMetadata(user.user_metadata);
    const on = remote ?? playerJourneyEnabledFromMetadata(user.user_metadata);
    setEnabled(on);
    if (!on) {
      setCount(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      const response = await journeyAuthedFetch("/api/player-journey/list");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load journals.");
      setCount(Array.isArray(payload.journeys) ? payload.journeys.length : 0);
    } catch {
      setCount(0);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user) return null;

  const status = loading
    ? "…"
    : loadError
      ? "Unavailable"
      : enabled
        ? count > 0
          ? `${count} game${count === 1 ? "" : "s"} tracked`
          : "On, no journals yet"
        : "Off";

  return (
    <div className="field profile-memory-link-field">
      <span className="field-label">{JOURNEY_TOGGLE_LABEL}</span>
      <p className="field-hint">{JOURNEY_TOGGLE_HINT}</p>
      <Link className="profile-memory-link" href="/profile/journey">
        <span className="profile-memory-link-label">Manage progress journals</span>
        <span className="profile-memory-link-status">{status}</span>
        <IconChevronRight size={18} aria-hidden />
      </Link>
    </div>
  );
}
