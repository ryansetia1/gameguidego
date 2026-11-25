"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { gameRoomKey } from "@/lib/game-room.js";
import { IGDB_ID_OFFSET } from "@/lib/games.js";
import { matchPlayingGame } from "@/lib/rlog-bridge.js";
import { getSupabase } from "@/lib/supabase";

/**
 * RLog bridge, client side (#71). Opt-in by construction: every request goes through
 * GGG's /api/rlog/* with the Supabase session token, and anything other than a
 * `{ matched: true }` answer leaves these hooks empty, so the UI renders nothing.
 */

export type RlogGame = {
  rlog_item_id: string;
  title: string;
  platform: string;
  cover: string;
  igdb_id: number | null;
  progress: { done: number; total: number };
};
export type RlogChapter = { id: string; title: string };
export type RlogStep = { id: string; chapter_id: string; title: string; done: boolean };
export type RlogChecklist = { game: RlogGame; chapters: RlogChapter[]; items: RlogStep[] };

async function rlogFetch(path: string, init?: RequestInit) {
  const supabase = getSupabase();
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  if (!token) return { matched: false as const };
  const res = await fetch(path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status !== 200) throw new Error(`rlog ${res.status}`);
  return (await res.json()) as { matched: boolean } & Record<string, unknown>;
}

// ponytail: sessionStorage caches (per user id) for stale-while-revalidate and offline
// read-only; a fresh app session starts empty. localStorage if offline-after-restart matters.
function readCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeCache(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota / private mode: cache is a nicety
  }
}

/** RLog games with status "playing"; null = nothing to show (not matched, loading, error). */
export function useRlogPlaying(userId: string | null) {
  const [games, setGames] = useState<RlogGame[] | null>(null);
  useEffect(() => {
    if (!userId) {
      setGames(null);
      return;
    }
    const key = `gg:rlog-playing:${userId}`;
    setGames(readCache<RlogGame[]>(key));
    let alive = true;
    rlogFetch("/api/rlog/playing")
      .then((data) => {
        if (!alive) return;
        const next = data.matched && Array.isArray(data.games) ? (data.games as RlogGame[]) : null;
        writeCache(key, next);
        setGames(next);
      })
      .catch(() => {
        // Network/server error: silent; a cached strip (offline) stays.
      });
    return () => {
      alive = false;
    };
  }, [userId]);
  return games;
}

export type ChecklistStatus = "none" | "loading" | "ready" | "error";

/**
 * One checklist store per room, shared by the game card entry, the Checklist pane and
 * the deep-link banner. Toggles are optimistic and serialized per step (last click
 * wins, stale responses ignored); a failed latest toggle rolls back and calls onError.
 */
export function useRlogChecklist({
  userId,
  playing,
  game,
  platform,
  catalogGameId,
  online,
  onError,
}: {
  userId: string | null;
  playing: RlogGame[] | null;
  game: string;
  platform: string;
  catalogGameId: number | null;
  online: boolean;
  onError: (message: string) => void;
}) {
  const igdb =
    catalogGameId != null && catalogGameId > IGDB_ID_OFFSET ? catalogGameId - IGDB_ID_OFFSET : null;
  // Only rooms that match a playing RLog game ever hit the checklist endpoint.
  const match = useMemo(
    () => (playing && game.trim() ? matchPlayingGame(playing, { igdb, game, platform }) : null),
    [playing, igdb, game, platform],
  );
  const roomKey = userId && match ? `${userId}|${gameRoomKey(game, platform)}|${igdb ?? ""}` : null;
  const cacheKey = roomKey ? `gg:rlog-checklist:${roomKey}` : "";

  const [data, setData] = useState<RlogChecklist | null>(null);
  const [status, setStatus] = useState<ChecklistStatus>("none");
  const [lost, setLost] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const dataRef = useRef(data);
  dataRef.current = data;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    setLost(false);
    if (!roomKey) {
      setData(null);
      setStatus("none");
      return;
    }
    const cached = readCache<RlogChecklist>(cacheKey);
    setData(cached);
    setStatus(cached ? "ready" : "loading");
    let alive = true;
    const params = new URLSearchParams({ game: game.trim().slice(0, 120), platform: platform.slice(0, 60) });
    if (igdb != null) params.set("igdb", String(igdb));
    rlogFetch(`/api/rlog/checklist?${params}`)
      .then((res) => {
        if (!alive) return;
        if (!res.matched) {
          writeCache(cacheKey, null);
          setData(null);
          setStatus("none");
          return;
        }
        const next = res as unknown as RlogChecklist;
        writeCache(cacheKey, { game: next.game, chapters: next.chapters, items: next.items });
        setData(next);
        setStatus("ready");
      })
      .catch(() => {
        if (alive) setStatus(cached ? "ready" : "error");
      });
    return () => {
      alive = false;
    };
    // game/platform/igdb are folded into roomKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, reloadTick]);

  const seqRef = useRef(new Map<string, number>());
  const queueRef = useRef(new Map<string, Promise<void>>());
  const confirmedRef = useRef(new Map<string, boolean>());

  const setStepDone = useCallback((stepId: string, done: boolean) => {
    const prev = dataRef.current;
    if (!prev) return;
    const next = { ...prev, items: prev.items.map((s) => (s.id === stepId ? { ...s, done } : s)) };
    dataRef.current = next;
    if (cacheKey) writeCache(cacheKey, next);
    setData(next);
  }, [cacheKey]);

  const toggle = useCallback(
    (stepId: string, done: boolean) => {
      const current = dataRef.current;
      const step = current?.items.find((s) => s.id === stepId);
      if (!current || !step || !online) return;
      if (!confirmedRef.current.has(stepId)) confirmedRef.current.set(stepId, step.done);
      const seq = (seqRef.current.get(stepId) ?? 0) + 1;
      seqRef.current.set(stepId, seq);
      setStepDone(stepId, done);
      const itemId = current.game.rlog_item_id;
      const run = async () => {
        let ok = false;
        try {
          const res = await rlogFetch("/api/rlog/checklist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item_id: itemId, checklist_item_id: stepId, done }),
          });
          if (!res.matched) {
            // The match went away (account or game): roll back and hide everything quietly.
            setStepDone(stepId, confirmedRef.current.get(stepId) ?? step.done);
            setLost(true);
            return;
          }
          confirmedRef.current.set(stepId, done);
          ok = true;
        } catch {
          ok = false;
        }
        if (!ok && seqRef.current.get(stepId) === seq) {
          setStepDone(stepId, confirmedRef.current.get(stepId) ?? step.done);
          onErrorRef.current("Couldn't update. Try again.");
        }
      };
      const prev = queueRef.current.get(stepId) ?? Promise.resolve();
      queueRef.current.set(stepId, prev.then(run));
    },
    [online, setStepDone],
  );

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  const visible = !lost && status !== "none";
  const progress = useMemo(() => {
    if (data) return { done: data.items.filter((s) => s.done).length, total: data.items.length };
    return match ? match.progress : { done: 0, total: 0 };
  }, [data, match]);

  return {
    /** Entry shows only for a matched room with at least one step. */
    available: visible && progress.total > 0,
    status: lost ? ("none" as const) : status,
    data: lost ? null : data,
    progress,
    toggle,
    reload,
  };
}

export type RlogChecklistStore = ReturnType<typeof useRlogChecklist>;
