"use client";

import { useEffect, useId, useRef, useState } from "react";
import { gameCardGuideRow } from "@/lib/guide-card-ui.js";
import {
  guideSourceStripLabel,
  isGuideUrlSelectable,
} from "@/lib/guide-source-selection.js";
import type { GuideIndexState } from "@/lib/guide-index-state";
import type { GuideMeta } from "../guide-link-field";
import { IconChevronDown } from "../icons";

export type GuideSourceStripProps = {
  preferredUrls: string[];
  guideMeta: Record<string, GuideMeta>;
  guideIndexState: GuideIndexState;
  selection: string[] | null;
  onChange: (selection: string[] | null) => void;
  disabled?: boolean;
  skipPreferredGuide?: boolean;
};

export function GuideSourceStrip({
  preferredUrls,
  guideMeta,
  guideIndexState,
  selection,
  onChange,
  disabled,
  skipPreferredGuide,
}: GuideSourceStripProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const isAuto = selection === null;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (preferredUrls.length <= 1 || skipPreferredGuide) return null;

  const summary = guideSourceStripLabel(
    selection,
    preferredUrls,
    guideMeta,
    guideIndexState,
  );

  function toggleGuide(url: string) {
    if (!isGuideUrlSelectable(url, guideIndexState)) return;
    if (isAuto) {
      onChange([url]);
      return;
    }
    if (selection.includes(url)) {
      const next = selection.filter((item) => item !== url);
      onChange(next.length ? next : null);
      return;
    }
    onChange([...selection, url]);
  }

  return (
    <div className="composer-guide-source" ref={wrapRef}>
      {open ? (
        <div
          className="composer-guide-source-panel"
          id={listId}
          role="group"
          aria-label="Guide sources"
        >
          <label className="composer-guide-source-row">
            <input
              type="checkbox"
              checked={isAuto}
              onChange={() => onChange(null)}
              disabled={disabled}
            />
            <span className="composer-guide-source-row-label">Auto (all guides)</span>
          </label>
          <div className="composer-guide-source-divider" aria-hidden />
          {preferredUrls.map((url) => {
            const row = gameCardGuideRow(url, guideMeta[url], guideIndexState[url]);
            const selectable = isGuideUrlSelectable(url, guideIndexState);
            const checked = !isAuto && selection.includes(url);
            const status =
              row.state === "indexed"
                ? null
                : row.state === "checking"
                  ? "Indexing…"
                  : row.state === "pending"
                    ? "Pending"
                    : row.state === "failed"
                      ? "Failed"
                      : row.state === "blocked"
                        ? "Blocked"
                        : row.state === "unavailable"
                          ? "Unavailable"
                          : "Not indexed";
            return (
              <label
                key={url}
                className={`composer-guide-source-row${selectable ? "" : " is-disabled"}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || !selectable}
                  onChange={() => toggleGuide(url)}
                />
                <span className="composer-guide-source-row-label">{row.label}</span>
                {status ? (
                  <span className="composer-guide-source-row-status">{status}</span>
                ) : null}
              </label>
            );
          })}
        </div>
      ) : null}
      <button
        type="button"
        className="composer-guide-source-trigger"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Guide sources for this question"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="composer-guide-source-trigger-text">
          Guides · <strong>{summary}</strong>
        </span>
        <IconChevronDown size={14} className={open ? "is-open" : undefined} />
      </button>
    </div>
  );
}
