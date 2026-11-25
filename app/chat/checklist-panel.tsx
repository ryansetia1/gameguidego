"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { IconChevronRight, IconX } from "../icons";
import { trapTab, useSplitLayout } from "./saved-answers-panel";
import type { RlogChecklistStore } from "./use-rlog";
import { firstOpenGroup, groupChecklist } from "@/lib/rlog-checklist.js";

const HIGHLIGHT_MS = 1200;

/**
 * RLog checklist for the open room (#71), in the Saved answers pane shell: drawer with a
 * focus trap below the split breakpoint, side column beside the chat above it.
 */
export function ChecklistPanel({
  game,
  store,
  online,
  focusStepId,
  inert = false,
  onClose,
}: {
  game: string;
  store: RlogChecklistStore;
  online: boolean;
  /** Deep-link step to scroll to and outline once the list is in. */
  focusStepId: string | null;
  inert?: boolean;
  onClose: () => void;
}) {
  const split = useSplitLayout();
  const paneRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { data, status, progress } = store;
  const groups = useMemo(() => (data ? groupChecklist(data.chapters, data.items) : []), [data]);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  // Default open: the chapter with the first unfinished step (plus the deep-link step's).
  useEffect(() => {
    if (open || groups.length === 0) return;
    const ids = new Set<string>();
    const first = firstOpenGroup(groups);
    if (first) ids.add(first);
    const focusGroup = focusStepId && groups.find((g) => g.items.some((s) => s.id === focusStepId));
    if (focusGroup) ids.add(focusGroup.id);
    setOpen(ids);
  }, [groups, open, focusStepId]);

  // Deep-link step: scroll it to the middle and outline it briefly.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!focusStepId || !open || focusedOnce.current) return;
    const el = document.getElementById(`rlog-step-${focusStepId}`);
    if (!el) return;
    focusedOnce.current = true;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    setHighlight(focusStepId);
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [focusStepId, open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (split && !paneRef.current?.contains(document.activeElement)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [split, onClose]);

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      const target =
        trigger && trigger !== document.body && document.contains(trigger)
          ? trigger
          : document.querySelector<HTMLElement>(".game-card-menu .kebab");
      target?.focus();
    };
  }, []);

  function toggleGroup(id: string) {
    setOpen((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const loading = status === "loading" && !data;
  return (
    <>
      <button
        type="button"
        className="library-backdrop open saved-backdrop"
        aria-label="Close checklist"
        onClick={onClose}
      />
      <section
        ref={paneRef}
        className="saved-pane checklist-pane"
        role={split ? "complementary" : "dialog"}
        aria-modal={split ? undefined : true}
        aria-label="Checklist"
        onKeyDown={split ? undefined : trapTab}
        inert={inert}
      >
        <div className="library-head">
          <span className="saved-head-title">
            Checklist
            <small className="saved-head-game">{game}</small>
          </span>
          <span className="saved-head-count">
            {loading ? "– / –" : `${progress.done} / ${progress.total}`}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="sidebar-close"
            aria-label="Close checklist"
            onClick={onClose}
          >
            <IconX />
          </button>
        </div>
        {!online && data && <p className="saved-offline">Offline. Checklist is read-only.</p>}
        {loading ? (
          <div className="checklist-skeleton" aria-label="Loading checklist">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="library-skeleton-bar" />
            ))}
          </div>
        ) : !data ? (
          <div className="saved-empty">
            <p className="saved-empty-title">Couldn&apos;t load the checklist</p>
            <button type="button" className="row-menu-item checklist-retry" onClick={store.reload}>
              Try again
            </button>
          </div>
        ) : (
          <div className="checklist-list">
            {groups.map((group) => {
              const expanded = open?.has(group.id) ?? false;
              const bodyId = `rlog-ch-${group.id}`;
              return (
                <div key={group.id} className="checklist-chapter">
                  <button
                    type="button"
                    className="checklist-chapter-head"
                    aria-expanded={expanded}
                    aria-controls={bodyId}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <IconChevronRight size={16} className="checklist-chevron" />
                    <strong>{group.title}</strong>
                    <span className="checklist-chapter-count">
                      {group.done} / {group.total}
                    </span>
                  </button>
                  <div id={bodyId} className="checklist-body" hidden={!expanded}>
                    <ul>
                      {group.items.map((step) => (
                        <li key={step.id}>
                          <label
                            id={`rlog-step-${step.id}`}
                            className={`checklist-step${step.done ? " is-done" : ""}${
                              highlight === step.id ? " is-highlight" : ""
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={step.done}
                              disabled={!online}
                              onChange={(event) => store.toggle(step.id, event.target.checked)}
                            />
                            <span>{step.title}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

/**
 * Deep-link `step=` strip under the game card: one tap marks the step done in RLog.
 * Renders nothing unless the step is loaded and still open (or was just marked here).
 */
export function ChecklistStepBanner({
  store,
  stepId,
  online,
  onDismiss,
}: {
  store: RlogChecklistStore;
  stepId: string;
  online: boolean;
  onDismiss: () => void;
}) {
  const step = store.data?.items.find((s) => s.id === stepId) ?? null;
  const [justDone, setJustDone] = useState(false);
  const [seenOpen, setSeenOpen] = useState(() => Boolean(step && !step.done));
  const rootRef = useRef<HTMLDivElement>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // The checklist can arrive after mount; only an unfinished step ever shows the banner.
  useEffect(() => {
    if (step && !step.done && !seenOpen) setSeenOpen(true);
  }, [step, seenOpen]);

  // A failed Mark done rolled the step back: return to the start state.
  useEffect(() => {
    if (justDone && step && !step.done) setJustDone(false);
  }, [justDone, step]);

  // "Done" state: hide after 4s unless focus is inside it.
  useEffect(() => {
    if (!justDone || !step?.done) return;
    const timer = window.setInterval(() => {
      if (!rootRef.current?.contains(document.activeElement)) onDismissRef.current();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [justDone, step?.done]);

  if (!step || !seenOpen) return null;
  if (step.done && !justDone) return null;

  return (
    <div ref={rootRef} className="checklist-banner" role="region" aria-label="Checklist step">
      {step.done ? (
        <>
          <strong className="checklist-banner-title">Done: {step.title}</strong>
          <button
            type="button"
            className="maps-btn-secondary checklist-banner-btn"
            disabled={!online}
            onClick={() => {
              setJustDone(false);
              store.toggle(step.id, false);
            }}
          >
            Undo
          </button>
        </>
      ) : (
        <>
          <span className="checklist-banner-box" aria-hidden="true" />
          <strong className="checklist-banner-title">{step.title}</strong>
          <button
            type="button"
            className="maps-btn-secondary checklist-banner-btn"
            disabled={!online}
            onClick={() => {
              setJustDone(true);
              store.toggle(step.id, true);
            }}
          >
            Mark done in RLog
          </button>
        </>
      )}
      <button type="button" className="checklist-banner-x" aria-label="Dismiss" onClick={onDismiss}>
        <IconX size={16} />
      </button>
    </div>
  );
}
