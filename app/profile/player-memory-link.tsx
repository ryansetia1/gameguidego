"use client";

import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { IconChevronRight } from "@/app/icons";
import {
  MEMORY_FULL_THRESHOLD,
  MEMORY_TOGGLE_HINT,
  MEMORY_TOGGLE_LABEL,
} from "@/lib/player-memory.js";
import { getSupabase } from "@/lib/supabase";

type Props = {
  session: Session | null;
};

function memoryStatusLabel(enabled: boolean, count: number) {
  if (!enabled) return "Off";
  if (count >= MEMORY_FULL_THRESHOLD) return "Active";
  return `${count}/${MEMORY_FULL_THRESHOLD} questions`;
}

export function PlayerMemoryLink({ session }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    const supabase = getSupabase();
    if (!session || !supabase) {
      setEnabled(false);
      setCount(0);
      setLoadError(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      const { data, error } = await supabase
        .from("player_memory_state")
        .select("message_count")
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        setEnabled(false);
        setCount(0);
        return;
      }
      setEnabled(true);
      setCount(typeof data.message_count === "number" ? data.message_count : 0);
    } catch {
      setEnabled(false);
      setCount(0);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session) return null;

  const status = loading ? "…" : loadError ? "Unavailable" : memoryStatusLabel(enabled, count);

  return (
    <div className="field profile-memory-link-field">
      <span className="field-label">{MEMORY_TOGGLE_LABEL}</span>
      <p className="field-hint">{MEMORY_TOGGLE_HINT}</p>
      <Link className="profile-memory-link" href="/profile/memory">
        <span className="profile-memory-link-label">Manage style memory</span>
        <span className="profile-memory-link-status">{status}</span>
        <IconChevronRight size={18} aria-hidden />
      </Link>
    </div>
  );
}
