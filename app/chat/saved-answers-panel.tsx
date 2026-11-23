"use client";

import { useEffect, useRef, useState } from "react";

import {
  IconArrowLeft,
  IconArrowUpRight,
  IconBookmark,
  IconClock,
  IconDotsVertical,
  IconX,
} from "../icons";
import { AnswerBody } from "./answer-body";
import { HighlightGroups, SpoilerReveals } from "./message-list";
import type { SavedAnswer } from "./use-saved-answers";
import {
  SAVED_DEVICE_CAP,
  SAVED_PER_GAME_CAP,
  isSpoilerGated,
  savedDateLabel,
  savedPreview,
} from "@/lib/saved-answers.js";
import { sourceHostname } from "@/lib/chat-message-ui.js";

const REMOVE_MS = 160;

/** Read-only snapshot of one saved answer (#18 swaps in the full reading view). */
function SavedAnswerView({
  item,
  spoilerMajor,
  onBack,
}: {
  item: SavedAnswer;
  spoilerMajor: boolean;
  onBack: () => void;
}) {
  const links = item.sources.filter((source) => /^https?:\/\//.test(source.url));
  return (
    <div className="saved-view">
      <div className="saved-view-head">
        <button
          type="button"
          className="sidebar-close"
          aria-label="Back to saved answers"
          onClick={onBack}
        >
          <IconArrowLeft />
        </button>
      </div>
      <div className="saved-view-body">
        <h1 className="saved-view-title">{item.question || "Saved answer"}</h1>
        <AnswerBody text={item.content} />
        {spoilerMajor && <SpoilerReveals spoilers={item.spoilers} />}
        <HighlightGroups highlights={item.highlights} />
        {links.length > 0 && (
          <ol className="source-list saved-view-sources">
            {links.map((source, i) => (
              <li key={`${source.url}-${i}`}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  <span className="source-number">{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{source.title}</strong>
                    <small>{sourceHostname(source.url)}</small>
                  </span>
                  <span className="source-arrow" aria-hidden="true">
                    <IconArrowUpRight />
                  </span>
                </a>
              </li>
            ))}
          </ol>
        )}
        <p className="saved-view-date">Saved {savedDateLabel(item.createdAt)}</p>
      </div>
    </div>
  );
}

/**
 * Per-game saved answers drawer (same shell as the saved library). Mounted only while
 * open; reads the device copy, so it works offline.
 */
export function SavedAnswersPanel({
  game,
  items,
  signedIn,
  spoilerMajor,
  deviceFull,
  online,
  syncFailed,
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
  onClose: () => void;
  onRemove: (item: SavedAnswer) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc closes an open row menu first, then the drawer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menuId) setMenuId(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuId, onClose]);

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

  const openItem = openId ? items.find((item) => item.id === openId) : undefined;

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
      <button
        type="button"
        className="library-backdrop open"
        aria-label="Close saved answers"
        onClick={onClose}
      />
      <div className="library open" role="dialog" aria-label="Saved answers">
        <div className="library-panel saved-panel">
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
          {!online && <p className="saved-offline">Offline, showing what&apos;s on this device</p>}
          {openItem ? (
            <SavedAnswerView
              item={openItem}
              spoilerMajor={spoilerMajor}
              onBack={() => setOpenId(null)}
            />
          ) : items.length === 0 ? (
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
                    <button type="button" className="saved-row-open" onClick={() => setOpenId(item.id)}>
                      <strong className="saved-row-title">{item.question || "Saved answer"}</strong>
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
                              setOpenId(item.id);
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
        </div>
      </div>
    </>
  );
}
