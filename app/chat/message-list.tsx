import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import {
  IconArrowUpRight,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconInfo,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconX,
} from "../icons";
import { AnswerBody } from "./answer-body";
import type { Message } from "./types";
import { WRITING_ANSWER_PLACEHOLDER, messageShowsVariantNav } from "@/lib/chat-messages.js";
import { KIND_LABELS, type Highlight } from "@/lib/highlights.js";
import {
  answerModeInfo,
  enrichMessageSources,
  groupHighlightsByKind,
  isUploadOnlySources,
  pipelineSourceLabel,
  sourceHostname,
  uploadedSourceGuideLabel,
} from "@/lib/chat-message-ui.js";
import type { GuideMeta } from "../guide-link-field";
import { isUploadedGuideUrl } from "@/lib/guide-urls.js";
import { visualImageProxyUrl } from "@/lib/visual-image-proxy.js";

/** Stop nudging for a guide after this many answers; re-nudge naturally in a new game. */
const NUDGE_MAX_ANSWERS = 10;

/**
 * The small "?" beside each answer. On tap it opens a quiet popover owning up to
 * the accuracy limits (web + model knowledge can be off) and offering the two
 * fixes: regenerate, or add a guide for source-backed answers. Kept off-screen
 * until asked for, so it never competes with the answer itself.
 */
const ANSWER_INFO_COPY: Record<"guide" | "web" | "knowledge", string> = {
  guide:
    "This leans on your guide, but a stray detail can still slip through. Double-check anything critical.",
  web: "This mixes what I know with a quick web search, so a detail here and there can be off.",
  knowledge:
    "This is straight from what I already know, no web search this round, so double-check the fine print.",
};

function AnswerInfo({
  mode,
  canAddGuide,
  disabled,
  onRetry,
  onAddGuide,
}: {
  mode: "guide" | "web" | "knowledge";
  canAddGuide: boolean;
  disabled: boolean;
  onRetry: () => void;
  onAddGuide?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="answer-info" ref={wrapRef}>
      <button
        type="button"
        className="answer-info-toggle"
        aria-label="How accurate is this answer?"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        ?
      </button>
      {open && (
        <div className="answer-info-pop" role="dialog" aria-label="About this answer">
          <p className="answer-info-copy">{ANSWER_INFO_COPY[mode]}</p>
          <div className="answer-info-actions">
            <button
              type="button"
              className="answer-info-btn"
              onClick={() => {
                setOpen(false);
                onRetry();
              }}
              disabled={disabled}
            >
              <IconRefresh size={13} /> Try again
            </button>
            {canAddGuide && onAddGuide && (
              <button
                type="button"
                className="answer-info-btn is-accent"
                onClick={() => {
                  setOpen(false);
                  onAddGuide();
                }}
              >
                <IconPlus size={13} /> Add a guide
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const ILLUSTRATION_INFO_COPY =
  "This image came from a web search. It might not match your game or question exactly.";

function IllustrationInfo() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="answer-illustration-info" ref={wrapRef}>
      <button
        type="button"
        className="answer-illustration-info-toggle"
        aria-label="About this reference image"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <IconInfo size={14} />
      </button>
      {open && (
        <div className="answer-info-pop answer-illustration-info-pop" role="dialog" aria-label="About this reference image">
          <p className="answer-info-copy">{ILLUSTRATION_INFO_COPY}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The bar at the foot of every answer. Left: what the answer was built from,
 * Left: provenance label, "?", and sources chevron when cited (bar expands sources).
 * Right: version arrows and regenerate. The bar is one expand hit-target except buttons.
 */
function AnswerFoot({
  message,
  index,
  guideMeta,
  canAddGuide,
  disabled,
  onRetry,
  onAddGuide,
  onNavigateVariant,
}: {
  message: Message;
  index: number;
  guideMeta: Record<string, GuideMeta>;
  canAddGuide: boolean;
  disabled: boolean;
  onRetry: () => void;
  onAddGuide?: () => void;
  onNavigateVariant: (msgIndex: number, variantIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const sources = enrichMessageSources(message.sources, guideMeta) as Message["sources"];
  const mode = answerModeInfo(message.pipelineType, sources);
  const expandable = Boolean(
    sources && sources.length > 0 && !isUploadOnlySources(sources),
  );

  let label: ReactNode;
  if (expandable) {
    label = (
      <>
        Sources ({sources!.length})
        <span className="answer-foot-sub">
          {" · "}
          {pipelineSourceLabel(message.pipelineType, sources)}
        </span>
      </>
    );
  } else if (isUploadOnlySources(sources)) {
    const uploadLabel = uploadedSourceGuideLabel(sources);
    label = (
      <>
        Sources
        {uploadLabel ? (
          <span className="answer-foot-sub">
            {" · "}
            {uploadLabel}
          </span>
        ) : null}
      </>
    );
  } else {
    // Knowledge-only: no sources to cite, so name the provenance instead.
    label = mode.label;
  }

  const variants =
    messageShowsVariantNav(message) && message.variants ? message.variants : null;
  const activeVariant = message.activeVariantIndex ?? 0;
  const toggleSources = () => setOpen((value) => !value);

  return (
    <div className="answer-foot">
      <div
        className={`answer-foot-bar${expandable ? " is-expandable" : ""}`}
        onClick={expandable ? toggleSources : undefined}
      >
        <span className="answer-foot-label">{label}</span>
        <div
          className="answer-foot-interactive"
          onClick={(event) => event.stopPropagation()}
        >
          <AnswerInfo
            mode={mode.mode as "guide" | "web" | "knowledge"}
            canAddGuide={canAddGuide}
            disabled={disabled}
            onRetry={onRetry}
            onAddGuide={onAddGuide}
          />
        </div>
        {expandable ? (
          <span className={`chevron-toggle${open ? " is-open" : ""}`} aria-hidden>
            <IconChevronDown size={14} />
          </span>
        ) : null}
        <div
          className="answer-foot-right"
          onClick={(event) => event.stopPropagation()}
        >
          {variants && (
            <div className="variant-nav">
              <button
                type="button"
                className="turn-action-icon variant-nav-btn"
                aria-label="Previous version"
                disabled={activeVariant === 0}
                onClick={(event) => {
                  event.currentTarget.blur();
                  onNavigateVariant(index, activeVariant - 1);
                }}
              >
                <IconChevronLeft size={14} />
              </button>
              <span>
                {activeVariant + 1} / {variants.length}
              </span>
              <button
                type="button"
                className="turn-action-icon variant-nav-btn"
                aria-label="Next version"
                disabled={activeVariant === variants.length - 1}
                onClick={(event) => {
                  event.currentTarget.blur();
                  onNavigateVariant(index, activeVariant + 1);
                }}
              >
                <IconChevronRight size={14} />
              </button>
            </div>
          )}
          <button
            type="button"
            className="turn-action turn-action-icon"
            aria-label="Regenerate answer"
            onClick={onRetry}
            disabled={disabled}
          >
            <IconRefresh />
          </button>
        </div>
      </div>
      {expandable && open && (
        <ol className="source-list">
          {sources!.map((source, i) => {
            const number = (
              <span className="source-number">{String(i + 1).padStart(2, "0")}</span>
            );
            // Uploaded files have no real URL to open (upload://…), so render
            // them as plain text, not a broken link.
            if (isUploadedGuideUrl(source.url)) {
              return (
                <li key={`${source.url}-${i}`}>
                  <div className="source-static-row">
                    {number}
                    <span>
                      <strong>{source.title}</strong>
                      <small>{uploadedSourceGuideLabel([source])}</small>
                    </span>
                  </div>
                </li>
              );
            }
            return (
              <li key={`${source.url}-${i}`}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {number}
                  <span>
                    <strong>{source.title}</strong>
                    <small>{sourceHostname(source.url)}</small>
                  </span>
                  <span className="source-arrow" aria-hidden="true">
                    <IconArrowUpRight />
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export type MessageListProps = {
  messages: Message[];
  loading: boolean;
  error: string;
  retryAction: (() => void) | null;
  editingIndex: number | null;
  spoilerMajor: boolean;
  generationStatus: string | null;
  indexingGuideCount: number;
  preferredUrlCount: number;
  lastUserIndex: number;
  lastGuideIndex: number;
  lastUserRef: RefObject<HTMLDivElement | null>;
  lastGuideRef: RefObject<HTMLElement | null>;
  feedRef: RefObject<HTMLDivElement | null>;
  editSlotRef: (el: HTMLDivElement | null) => void;
  onStartEdit: (index: number) => void;
  onRetry: (index: number) => void;
  onNavigateVariant: (msgIndex: number, variantIndex: number) => void;
  onOpenLightbox: (images: string[], index: number) => void;
  onAddGuide?: () => void;
  guideUpsellDismissed?: boolean;
  onDismissGuideUpsell?: () => void;
  guideMeta?: Record<string, GuideMeta>;
};

export function MessageList({
  messages,
  loading,
  error,
  retryAction,
  editingIndex,
  spoilerMajor,
  generationStatus,
  indexingGuideCount,
  preferredUrlCount,
  lastUserIndex,
  lastGuideIndex,
  lastUserRef,
  lastGuideRef,
  feedRef,
  editSlotRef,
  onStartEdit,
  onRetry,
  onNavigateVariant,
  onOpenLightbox,
  onAddGuide,
  guideUpsellDismissed,
  onDismissGuideUpsell,
  guideMeta = {},
}: MessageListProps) {
  const answerCount = messages.reduce(
    (count, message) => (message.role === "assistant" ? count + 1 : count),
    0,
  );
  return (
    <section className="feed" aria-live="polite">
      {messages.map((message, index) =>
        message.role === "user" ? (
          <div
            className={`turn user${editingIndex === index ? " editing" : ""}`}
            key={index}
            id={`msg-${index}`}
            ref={index === lastUserIndex ? lastUserRef : undefined}
          >
            {editingIndex === index ? (
              // The composer is portaled into this slot (see page.tsx) so editing
              // happens right where the message sits, replacing the green bubble.
              <div className="composer-edit-slot" ref={editSlotRef} />
            ) : (
              <>
                {message.images && message.images.length > 0 && (
                  <div className="msg-images">
                    {message.images.map((url, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <a key={i} href={url} target="_blank" rel="noreferrer">
                        <img
                          className="msg-image"
                          src={url}
                          alt="Attached"
                          loading="lazy"
                          onClick={(event) => {
                            event.preventDefault();
                            onOpenLightbox(message.images!, i);
                          }}
                          style={{ cursor: "zoom-in" }}
                        />
                      </a>
                    ))}
                  </div>
                )}
                <div className="user-bubble">
                  <p>{message.content}</p>
                  <button
                    type="button"
                    className="turn-action turn-action-icon"
                    aria-label="Edit message"
                    onClick={() => onStartEdit(index)}
                    disabled={loading}
                  >
                    <IconPencil />
                  </button>
                </div>
              </>
            )}
          </div>
        ) : loading && message.content === WRITING_ANSWER_PLACEHOLDER ? (
          // Regen: this bubble is just the placeholder while the loading card
          // below shows progress — hide it so "Writing answer..." isn't doubled.
          // The real answer replaces the placeholder and the bubble returns.
          null
        ) : (
          <article
            className="turn guide"
            key={index}
            id={`msg-guide-${index}`}
            ref={index === lastGuideIndex ? lastGuideRef : undefined}
          >
            <AnswerBody text={message.content} />
            {message.illustration && (
              <figure className="answer-illustration">
                <div className="answer-illustration-frame">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="answer-illustration-image"
                    src={visualImageProxyUrl(message.illustration.url)}
                    alt={message.illustration.alt}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      // CloudFlare/captcha/dead host: hide the whole figure so no
                      // broken icon or dangling "Reference image" caption shows.
                      // Hide (not .remove()) — React owns this node; removing it
                      // crashes reconciliation when the message re-renders.
                      const fig = event.currentTarget.closest("figure");
                      if (fig) fig.style.display = "none";
                    }}
                    onClick={() =>
                      onOpenLightbox([visualImageProxyUrl(message.illustration!.url)], 0)
                    }
                    style={{ cursor: "zoom-in" }}
                  />
                  <IllustrationInfo />
                </div>
                {message.illustration.sourceUrl ? (
                  <figcaption className="answer-illustration-caption">
                    <a href={message.illustration.sourceUrl} target="_blank" rel="noreferrer">
                      Reference image
                    </a>
                  </figcaption>
                ) : null}
              </figure>
            )}
            {message.spoilers && spoilerMajor && message.spoilers.length > 0 && (
              <div className="spoiler-reveals">
                {message.spoilers.map((item, i) => (
                  <details key={`spoiler-${i}`} className="spoiler-reveal">
                    <summary>
                      <span className="spoiler-reveal-tag">Major spoiler</span>
                      {item.title || "Tap to reveal"}
                    </summary>
                    <AnswerBody text={item.detail} />
                  </details>
                ))}
              </div>
            )}
            {message.highlights && message.highlights.length > 0 && (
              <div className="highlights">
                {groupHighlightsByKind(message.highlights).map(({ kind, items }) => (
                  <section key={kind} className="highlight-group">
                    <h3 className="highlight-label">{KIND_LABELS[kind]}</h3>
                    <ul className="highlight-list">
                      {(items as Highlight[]).map((item, i) =>
                        item.detail ? (
                          <li key={`${kind}-${i}`}>
                            <details className={`highlight highlight-${kind}`}>
                              <summary>{item.title}</summary>
                              <p>{item.detail}</p>
                            </details>
                          </li>
                        ) : (
                          <li key={`${kind}-${i}`}>
                            <div className={`highlight highlight-${kind} highlight-note`}>
                              {item.title}
                            </div>
                          </li>
                        ),
                      )}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            {onAddGuide &&
              index === lastGuideIndex &&
              preferredUrlCount === 0 &&
              !guideUpsellDismissed &&
              answerCount <= NUDGE_MAX_ANSWERS &&
              message.content !== WRITING_ANSWER_PLACEHOLDER &&
              !answerModeInfo(message.pipelineType, message.sources).guideBacked && (
                <div className="answer-upsell">
                  <p className="answer-upsell-copy">
                    Have a walkthrough? Get answers straight from the source.
                  </p>
                  <button
                    type="button"
                    className="answer-upsell-cta icon-inline"
                    onClick={onAddGuide}
                  >
                    <IconPlus size={14} /> Guide
                  </button>
                  {onDismissGuideUpsell && (
                    <button
                      type="button"
                      className="answer-upsell-dismiss"
                      onClick={onDismissGuideUpsell}
                      aria-label="Don't show this for this game"
                      title="Don't show this for this game"
                    >
                      <IconX size={14} />
                    </button>
                  )}
                </div>
              )}
            {message.content !== WRITING_ANSWER_PLACEHOLDER && (
              <AnswerFoot
                message={message}
                index={index}
                guideMeta={guideMeta}
                canAddGuide={preferredUrlCount === 0 && !!onAddGuide}
                disabled={loading}
                onRetry={() => void onRetry(index)}
                onAddGuide={onAddGuide}
                onNavigateVariant={onNavigateVariant}
              />
            )}
          </article>
        ),
      )}

      {loading && (
        <div className="turn guide loading-card">
          <span className="scan-line" aria-hidden="true" />
          <p>
            {indexingGuideCount
              ? indexingGuideCount > 1
                ? `Memorizing ${indexingGuideCount} guides for the first time...`
                : "Memorizing your guide for the first time..."
              : generationStatus ||
                (preferredUrlCount
                  ? WRITING_ANSWER_PLACEHOLDER
                  : "Looking for answers online...")}
          </p>
        </div>
      )}

      {error && (
        <div
          className="error-card"
          role="alert"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span aria-hidden="true">!</span>
            <p>{error}</p>
          </div>
          {retryAction && (
            <button
              type="button"
              className="btn-icon"
              style={{ color: "var(--text-muted)" }}
              onClick={() => retryAction()}
              aria-label="Retry"
            >
              <IconRefresh />
            </button>
          )}
        </div>
      )}
      <div ref={feedRef} />
    </section>
  );
}
