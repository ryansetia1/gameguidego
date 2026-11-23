"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { IconArrowLeft, IconArrowUpRight, IconList, IconX } from "../icons";
import { AnswerBody } from "./answer-body";
import { HighlightGroups, SpoilerReveals } from "./message-list";
import type { SavedAnswer } from "./use-saved-answers";
import { parseBlocks } from "@/lib/markdown.js";
import {
  clearReadingPos,
  loadReadingPos,
  positionFromScroll,
  saveReadingPos,
  scrollFromPosition,
} from "@/lib/reading-pos.js";
import { loadSavedItems, savedDateLabel } from "@/lib/saved-answers.js";
import { sourceHostname } from "@/lib/chat-message-ui.js";

const SAVE_DEBOUNCE_MS = 300;
const CHIP_MS = 4000;
/** Restoring further down than this many screens shows "Continued where you left off". */
const CHIP_SCREENS = 5;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The heading whose top passed this line (fraction of the viewport) is "current". */
const CURRENT_LINE = 0.1;

/** Heading tops in the scroller's content coordinates. */
function headingTops(scroller: HTMLElement, count: number) {
  const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const tops: number[] = [];
  for (let i = 0; i < count; i++) {
    const el = scroller.querySelector<HTMLElement>(`#sec-${i}`);
    if (!el) break;
    tops.push(el.getBoundingClientRect().top - top);
  }
  return tops;
}

/** Index of the section whose heading has passed CURRENT_LINE (-1 = before the first). */
function sectionAtLine(scroller: HTMLElement, count: number) {
  const tops = headingTops(scroller, count);
  return positionFromScroll(scroller.scrollTop + scroller.clientHeight * CURRENT_LINE + 1, tops)
    .section;
}

/**
 * Reading view for one saved answer (#18): comfortable type, a Sections jump list built
 * from the answer's own headings, and a remembered position per item. Placement
 * (full-screen vs side panel) is the parent pane's CSS; this only renders content.
 */
export function ReadingView({
  itemId,
  item,
  game,
  spoilerMajor,
  online,
  onBack,
  onClose,
}: {
  itemId: string;
  /** Undefined when the item was removed (e.g. on another device) while open. */
  item: SavedAnswer | undefined;
  game: string;
  spoilerMajor: boolean;
  online: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionsBtnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [chip, setChip] = useState(false);
  // Parent keys this view by item id, so "restore once" means once per mount.
  const restored = useRef(false);

  const content = item?.content ?? "";
  const sections = useMemo(
    () =>
      parseBlocks(content)
        .filter((block) => block.type === "h")
        .map((block) => block.segments.map((seg) => seg.text).join("")),
    [content],
  );

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, [itemId]);

  // Restore the remembered position silently; a fresh item starts at the top.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !item || restored.current) return;
    restored.current = true;
    const pos = loadReadingPos(itemId);
    const target = pos ? scrollFromPosition(pos, headingTops(scroller, sections.length)) : null;
    scroller.scrollTop = target ?? 0;
    if (target != null && target > scroller.clientHeight * CHIP_SCREENS) {
      const show = requestAnimationFrame(() => setChip(true));
      const hide = window.setTimeout(() => setChip(false), CHIP_MS);
      return () => {
        cancelAnimationFrame(show);
        window.clearTimeout(hide);
      };
    }
  }, [itemId, item, sections.length]);

  // Item gone: forget its position, but only when the device store really lost it
  // (not a transient empty render).
  useEffect(() => {
    if (item) return;
    const stillStored = loadSavedItems().some((row) => row.id === itemId && !row.deleted);
    if (!stillStored) clearReadingPos(itemId);
  }, [item, itemId]);

  // Save position on scroll (debounced) and once more on close. Layout effect so the
  // close-time save measures headings before the DOM is detached.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !item) return;
    let timer = 0;
    const save = () =>
      saveReadingPos(
        itemId,
        positionFromScroll(scroller.scrollTop, headingTops(scroller, sections.length)),
      );
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, SAVE_DEBOUNCE_MS);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
      save();
    };
  }, [itemId, item, sections.length]);

  // Track the current section with an IntersectionObserver (no scroll listener).
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || sections.length === 0) return;
    // The root band ends at CURRENT_LINE, so a callback fires exactly when a heading
    // crosses the line the section is computed against.
    const observer = new IntersectionObserver(
      () => setCurrent(sectionAtLine(scroller, sections.length)),
      {
        root: scroller,
        rootMargin: `0px 0px -${100 - CURRENT_LINE * 100}% 0px`,
        threshold: [0, 1],
      },
    );
    for (let i = 0; i < sections.length; i++) {
      const el = scroller.querySelector(`#sec-${i}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections.length, content]);

  // Sections popover: focus the current entry on open; outside click closes.
  useEffect(() => {
    if (!sectionsOpen) return;
    const pop = popRef.current;
    (
      pop?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? pop?.querySelector("button")
    )?.focus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popRef.current?.contains(target) && !sectionsBtnRef.current?.contains(target)) {
        setSectionsOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [sectionsOpen]);

  function jumpTo(index: number) {
    const scroller = scrollRef.current;
    const el = scroller?.querySelector<HTMLElement>(`#sec-${index}`);
    if (!scroller || !el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    setCurrent(index);
  }

  function onPopKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(popRef.current?.querySelectorAll("button") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSectionsOpen(false);
      sectionsBtnRef.current?.focus();
    }
  }

  function onBodyKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (sections.length < 2 || event.altKey || event.ctrlKey || event.metaKey) return;
    const scroller = scrollRef.current;
    if (!scroller || (event.key !== "]" && event.key !== "[")) return;
    event.preventDefault();
    // Measure now: a smooth scroll may still be settling.
    const at = sectionAtLine(scroller, sections.length);
    jumpTo(event.key === "]" ? Math.min(at + 1, sections.length - 1) : Math.max(at - 1, 0));
  }

  const sources = item?.sources ?? [];

  return (
    <div className="reading">
      <div className="reading-bar">
        <button
          ref={backRef}
          type="button"
          className="reading-bar-btn"
          aria-label="Back to saved answers"
          onClick={onBack}
        >
          <IconArrowLeft />
        </button>
        <span className="reading-bar-game">{game}</span>
        {sections.length >= 2 && (
          <div className="reading-sections">
            <button
              ref={sectionsBtnRef}
              type="button"
              className="reading-bar-btn reading-sections-btn"
              aria-expanded={sectionsOpen}
              aria-controls={sectionsOpen ? "reading-sections" : undefined}
              onClick={() => {
                if (!sectionsOpen && scrollRef.current)
                  setCurrent(sectionAtLine(scrollRef.current, sections.length));
                setSectionsOpen((open) => !open);
              }}
            >
              <IconList size={16} /> Sections
            </button>
            {sectionsOpen && (
              <div
                ref={popRef}
                id="reading-sections"
                className="row-menu-pop reading-sections-pop"
                role="group"
                aria-label="Sections"
                onKeyDown={onPopKey}
                onBlur={(event) => {
                  // Tabbing out of the list closes it (focus left both list and button).
                  const next = event.relatedTarget as Node | null;
                  if (
                    next &&
                    !popRef.current?.contains(next) &&
                    !sectionsBtnRef.current?.contains(next)
                  ) {
                    setSectionsOpen(false);
                  }
                }}
              >
                {sections.map((title, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`row-menu-item reading-sections-item${i === current ? " is-current" : ""}`}
                    aria-current={i === current ? "true" : undefined}
                    onClick={() => {
                      setSectionsOpen(false);
                      jumpTo(i);
                      scrollRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    {title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="reading-bar-btn reading-close"
          aria-label="Close saved answers"
          onClick={onClose}
        >
          <IconX />
        </button>
      </div>
      {!online && <p className="saved-offline">Offline, showing what&apos;s on this device</p>}
      {chip && <p className="reading-chip">Continued where you left off</p>}
      <div
        ref={scrollRef}
        className="reading-scroll"
        tabIndex={0}
        aria-label="Saved answer text"
        onKeyDown={onBodyKey}
      >
        {item ? (
          <article className="reading-page">
            <h1 className="reading-title">{item.question || "Saved answer"}</h1>
            <p className="reading-date">Saved {savedDateLabel(item.createdAt)}</p>
            <AnswerBody text={item.content} sectionIds />
            {spoilerMajor && <SpoilerReveals spoilers={item.spoilers} />}
            <HighlightGroups highlights={item.highlights} />
            {sources.length > 0 && (
              <ol className="source-list reading-sources">
                {sources.map((source, i) => (
                  <li key={`${source.url}-${i}`}>
                    {/* Uploaded files / journal have no openable URL: plain text, as in chat. */}
                    {!/^https?:\/\//.test(source.url) ? (
                      <div className="source-static-row">
                        <span className="source-number">{String(i + 1).padStart(2, "0")}</span>
                        <span>
                          <strong>{source.title}</strong>
                        </span>
                      </div>
                    ) : (
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
                    )}
                  </li>
                ))}
              </ol>
            )}
          </article>
        ) : (
          <div className="saved-empty">
            <p className="saved-empty-title">This saved answer is gone.</p>
            <button type="button" className="nav-button" onClick={onBack}>
              Back to saved answers
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
