"use client";

import { type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { IconBookmark, IconClock, IconDotsVertical, IconX } from "../icons";
import { ReadingView } from "./reading-view";
import type { SavedAnswer } from "./use-saved-answers";
import {
  SAVED_DEVICE_CAP,
  SAVED_PER_GAME_CAP,
  isSpoilerGated,
  savedDateLabel,
  savedPreview,
} from "@/lib/saved-answers.js";

const REMOVE_MS = 160;

/**
 * Two-panel breakpoint: wide viewports and landscape handhelds (Steam Deck 1280x800 by
 * width, phones sideways by the second clause). Layout switches in CSS (`.app-split`,
 * globals.css); JS reads it only to pick the ARIA role and whether focus is trapped.
 * Keep in sync with the @media rule in globals.css.
 */
// ponytail: the query string lives here and in two @media blocks; upgrade path is a
// single CSS custom media / generated stylesheet if the breakpoint changes often.
export const SPLIT_QUERY =
  "(min-width: 900px), (orientation: landscape) and (min-width: 640px) and (max-height: 600px)";

function subscribeSplit(fn: () => void) {
  const mq = window.matchMedia(SPLIT_QUERY);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}

function useSplitLayout() {
  return useSyncExternalStore(
    subscribeSplit,
    () => window.matchMedia(SPLIT_QUERY).matches,
    () => false,
  );
}

/** Keep Tab inside the full-screen dialog (narrow layout only). */
function trapTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusables = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Per-game saved answers pane: the list, or one answer in the reading view. Narrow: a
 * drawer (list) or full-screen dialog (reading). Wide/landscape: a side column beside the
 * chat, no backdrop, no focus trap. Mounted only while open; reads the device copy, so it
 * works offline.
 */
export function SavedAnswersPanel({
  game,
  items,
  signedIn,
  spoilerMajor,
  deviceFull,
  online,
  syncFailed,
  readingId,
  onOpenItem,
  onBack,
  onClose,
  onRemove,
}: {
  game: string;
  items: SavedAnswer[];
  signedIn: boolean;
  /** Same gate as the chat: major-spoiler reveals render only when spoilers are on. */
  spoilerMajor: boolean;
  deviceFull: boolean;
  online: boolean;
  syncFailed: boolean;
  /** Saved item open in the reading view; null shows the list. */
  readingId: string | null;
  onOpenItem: (id: string) => void;
  /** Reading view → list. */
  onBack: () => void;
  onClose: () => void;
  onRemove: (item: SavedAnswer) => void;
}) {
  const split = useSplitLayout();
  const paneRef = useRef<HTMLElement>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc: row menu first, then reading view → list, then close. Side-panel mode only
  // reacts while focus is inside the panel, so the chat keeps its own keys.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      // A nested control (Sections popover) already handled it.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (split && !paneRef.current?.contains(document.activeElement)) return;
      if (menuId) setMenuId(null);
      // Side panel: Esc removes it. Full screen: reading view steps back to the list first.
      else if (readingId && !split) onBack();
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [split, menuId, readingId, onBack, onClose]);

  // Back from the reading view: its focused Back button unmounted, so land on close
  // (keeps the narrow-layout focus trap working).
  const wasReading = useRef(false);
  useEffect(() => {
    if (!readingId && wasReading.current) closeRef.current?.focus();
    wasReading.current = Boolean(readingId);
  }, [readingId]);

  // Focus the close button on open and hand focus back to the trigger on close.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      // The kebab item that opened us unmounts in the same commit, so the captured
      // trigger is often <body>; fall back to the game card kebab.
      const target =
        trigger && trigger !== document.body && document.contains(trigger)
          ? trigger
          : document.querySelector<HTMLElement>(".game-card-menu .kebab");
      target?.focus();
    };
  }, []);

  const readingItem = readingId ? items.find((item) => item.id === readingId) : undefined;

  function remove(item: SavedAnswer) {
    setMenuId(null);
    setRemovingId(item.id);
    window.setTimeout(() => {
      setRemovingId(null);
      onRemove(item);
    }, REMOVE_MS);
  }

  return (
    <>
      {!readingId && (
        <button
          type="button"
          className="library-backdrop open saved-backdrop"
          aria-label="Close saved answers"
          onClick={onClose}
        />
      )}
      <section
        ref={paneRef}
        className={`saved-pane${readingId ? " is-reading" : ""}`}
        role={split ? "complementary" : "dialog"}
        aria-modal={split ? undefined : true}
        aria-label={readingId ? "Saved answer" : "Saved answers"}
        onKeyDown={split ? undefined : trapTab}
      >
        {readingId ? (
          <ReadingView
            key={readingId}
            itemId={readingId}
            item={readingItem}
            game={game}
            spoilerMajor={spoilerMajor}
            online={online}
            onBack={onBack}
            onClose={onClose}
          />
        ) : (
          <>
            <div className="library-head">
              <span className="saved-head-title">
                Saved answers
                <small className="saved-head-game">{game}</small>
              </span>
              {items.length >= SAVED_PER_GAME_CAP ? (
                <span className="saved-head-count">
                  {items.length} / {SAVED_PER_GAME_CAP}
                </span>
              ) : deviceFull ? (
                <span className="saved-head-count">
                  {SAVED_DEVICE_CAP} / {SAVED_DEVICE_CAP}
                </span>
              ) : null}
              <button
                ref={closeRef}
                type="button"
                className="sidebar-close"
                aria-label="Close saved answers"
                onClick={onClose}
              >
                <IconX />
              </button>
            </div>
            {!online && (
              <p className="saved-offline">Offline, showing what&apos;s on this device</p>
            )}
            {items.length === 0 ? (
              <div className="saved-empty">
                <IconBookmark size={32} />
                <p className="saved-empty-title">Nothing saved for this game yet</p>
                <p className="saved-empty-sub">
                  Tap the bookmark under an answer to keep it here, even offline.
                </p>
              </div>
            ) : (
              <>
                {signedIn && syncFailed && (
                  <p className="saved-sync-banner">
                    Couldn&apos;t sync. We&apos;ll retry when you&apos;re back online.
                  </p>
                )}
                <ul className="saved-list">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className={`saved-row${removingId === item.id ? " is-removing" : ""}`}
                    >
                      <button
                        type="button"
                        className="saved-row-open"
                        onClick={() => onOpenItem(item.id)}
                      >
                        <strong className="saved-row-title">
                          {item.question || "Saved answer"}
                        </strong>
                        {isSpoilerGated(item) ? (
                          <span className="saved-row-preview saved-row-spoiler">
                            Spoiler hidden. Open to reveal.
                          </span>
                        ) : (
                          <span className="saved-row-preview">{savedPreview(item.content)}</span>
                        )}
                        <span className="saved-row-meta">
                          {savedDateLabel(item.createdAt)}
                          {signedIn && !item.synced ? (
                            syncFailed ? (
                              <span className="saved-chip">
                                <IconClock size={12} /> Not synced
                              </span>
                            ) : (
                              <span className="saved-chip">On this device</span>
                            )
                          ) : null}
                        </span>
                      </button>
                      <div className="row-menu saved-row-menu">
                        <button
                          type="button"
                          className="kebab"
                          aria-label={`Options for ${item.question || "saved answer"}`}
                          aria-haspopup="menu"
                          aria-expanded={menuId === item.id}
                          onClick={() => setMenuId((id) => (id === item.id ? null : item.id))}
                        >
                          <IconDotsVertical />
                        </button>
                        {menuId === item.id && (
                          <div className="row-menu-pop" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="row-menu-item"
                              onClick={() => {
                                setMenuId(null);
                                onOpenItem(item.id);
                              }}
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="row-menu-item row-menu-delete"
                              onClick={() => remove(item)}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
