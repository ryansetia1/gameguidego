"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  SAVED_DEVICE_CAP,
  addItem,
  buildSavedItem,
  claimAnon,
  findSaved,
  isMissingTableError,
  itemsForGame,
  loadSavedItems,
  mergeRemote,
  removeItem,
  restoreItem,
  toRow,
  visibleItems,
  writeSavedItems,
} from "@/lib/saved-answers.js";
import { getSupabase } from "@/lib/supabase";
import type { Highlight, SpoilerReveal } from "@/lib/highlights.js";
import type { Source } from "./types";

export type SavedAnswer = {
  id: string;
  owner: string | null;
  gameKey: string;
  game: string;
  platform: string;
  question: string;
  content: string;
  highlights: Highlight[];
  spoilers: SpoilerReveal[];
  sources: Source[];
  createdAt: string;
  synced: boolean;
  deleted: boolean;
};

export type SaveResult =
  | { status: "saved"; item: SavedAnswer }
  | { status: "removed"; item: SavedAnswer }
  | { status: "cap" }
  | { status: "error" };

// Set once the server says `saved_answers` doesn't exist (migration not applied):
// the rest of the session is device-only and quiet (no banner, no retries).
let serverTableMissing = false;

// Device store as an external store: one cached snapshot shared by every reader,
// refreshed on our own writes and on writes from other tabs (`storage` event).
const EMPTY: SavedAnswer[] = [];
let snapshot: SavedAnswer[] | null = null;
const listeners = new Set<() => void>();

function readStore(): SavedAnswer[] {
  if (!snapshot) snapshot = loadSavedItems() as SavedAnswer[];
  return snapshot;
}

/** Persist (throws on quota/private mode) and notify readers. */
function writeStore(next: SavedAnswer[]) {
  writeSavedItems(next);
  snapshot = next;
  listeners.forEach((fn) => fn());
}

function subscribeStore(fn: () => void) {
  listeners.add(fn);
  const onStorage = () => {
    snapshot = null;
    fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

function subscribeOnline(fn: () => void) {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => {
    window.removeEventListener("online", fn);
    window.removeEventListener("offline", fn);
  };
}

/**
 * Device-first saved answers. localStorage is the source the UI reads (works offline);
 * signed-in users sync to `public.saved_answers` on open, on `online`, and after each change.
 * Sync never blocks: a failure only flips `syncFailed` and retries on the next trigger.
 */
export function useSavedAnswers(user: User | null) {
  const owner = user?.id ?? null;
  const items = useSyncExternalStore(subscribeStore, readStore, () => EMPTY);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [syncFailed, setSyncFailed] = useState(false);
  const [syncAvailable, setSyncAvailable] = useState(() => !serverTableMissing);
  const syncing = useRef(false);
  const rerun = useRef(false);

  const syncOnce = useCallback(async () => {
    const supabase = getSupabase();
    if (!owner || !supabase || serverTableMissing) return;
    try {
      let local = claimAnon(loadSavedItems(), owner) as SavedAnswer[];
      writeStore(local);
      const mine = local.filter((row) => row.owner === owner);
      const pending = mine.filter((row) => !row.synced && !row.deleted);
      const tombs = mine.filter((row) => row.deleted).map((row) => row.id);
      if (pending.length) {
        const { error } = await supabase.from("saved_answers").upsert(pending.map(toRow));
        if (error) throw error;
      }
      if (tombs.length) {
        const { error } = await supabase.from("saved_answers").delete().in("id", tombs);
        if (error) throw error;
      }
      const { data, error } = await supabase
        .from("saved_answers")
        .select("*")
        .eq("user_id", owner);
      if (error) throw error;
      // Re-read: the player may have saved/removed while the requests were in flight.
      local = mergeRemote(
        loadSavedItems(),
        owner,
        data ?? [],
        pending.map((row) => row.id),
        tombs,
      ) as SavedAnswer[];
      writeStore(local);
      setSyncFailed(false);
    } catch (error) {
      if (isMissingTableError(error)) {
        serverTableMissing = true;
        setSyncAvailable(false);
        setSyncFailed(false);
        return;
      }
      setSyncFailed(true);
    }
  }, [owner]);

  // Read through a ref so a queued pass uses the current owner, not the one the run started with.
  const syncOnceRef = useRef(syncOnce);
  useEffect(() => {
    syncOnceRef.current = syncOnce;
  }, [syncOnce]);

  /** One sync at a time; a request during a run queues exactly one more pass. */
  const sync = useCallback(async () => {
    if (!navigator.onLine) return;
    if (syncing.current) {
      rerun.current = true;
      return;
    }
    syncing.current = true;
    do {
      rerun.current = false;
      await syncOnceRef.current();
    } while (rerun.current);
    syncing.current = false;
  }, []);

  // Sync on app open / sign-in and whenever the device comes back online.
  useEffect(() => {
    if (owner && online) void sync();
  }, [owner, online, sync]);

  const commit = useCallback(
    (next: SavedAnswer[]) => {
      writeStore(next); // throws on quota/private mode
      void sync();
    },
    [sync],
  );

  /** Save or unsave one reply. */
  const toggle = useCallback(
    (input: {
      game: string;
      platform: string;
      question: string;
      message: { content: string; highlights?: Highlight[]; spoilers?: SpoilerReveal[]; sources?: Source[] };
    }): SaveResult => {
      const current = loadSavedItems() as SavedAnswer[];
      const existing = findSaved(current, owner, input.game, input.message.content) as
        | SavedAnswer
        | undefined;
      try {
        if (existing) {
          commit(removeItem(current, existing.id) as SavedAnswer[]);
          return { status: "removed", item: existing };
        }
        const item = buildSavedItem({ owner, ...input }) as SavedAnswer;
        const added = addItem(current, item);
        if (added.error) return { status: "cap" };
        commit(added.items as SavedAnswer[]);
        return { status: "saved", item };
      } catch {
        return { status: "error" };
      }
    },
    [owner, commit],
  );

  const remove = useCallback(
    (item: SavedAnswer) => {
      try {
        commit(removeItem(loadSavedItems(), item.id) as SavedAnswer[]);
        return true;
      } catch {
        return false;
      }
    },
    [commit],
  );

  const restore = useCallback(
    (item: SavedAnswer) => {
      try {
        commit(restoreItem(loadSavedItems(), item) as SavedAnswer[]);
      } catch {
        // Undo is best-effort; the item stays removed.
      }
    },
    [commit],
  );

  /** Newest-first saved answers for one game, as this viewer sees them. */
  const forGame = useCallback(
    (game: string) => itemsForGame(items, owner, game) as SavedAnswer[],
    [items, owner],
  );
  const isSaved = useCallback(
    (game: string, content: string) => Boolean(findSaved(items, owner, game, content)),
    [items, owner],
  );
  /** Any game: the open reading item must survive a game change in the chat. */
  const byId = useCallback(
    (id: string) => visibleItems(items, owner).find((row) => row.id === id) as SavedAnswer | undefined,
    [items, owner],
  );
  const deviceFull = visibleItems(items, owner).length >= SAVED_DEVICE_CAP;

  return {
    forGame,
    byId,
    isSaved,
    deviceFull,
    online,
    syncFailed,
    /** False when sync is off for this session (server table missing): device-only wording. */
    syncAvailable,
    toggle,
    remove,
    restore,
  };
}
