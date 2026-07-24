"use client";

import { useEffect, useRef, useState, type ElementType } from "react";

const CHAR_MS = 26;

type TopicTitleTypewriterProps = {
  title: string;
  pending?: boolean;
  className?: string;
  as?: ElementType;
};

/** Skeleton while pending, then type in a freshly generated topic title. */
export function TopicTitleTypewriter({
  title,
  pending = false,
  className = "",
  as: Tag = "span",
}: TopicTitleTypewriterProps) {
  const [display, setDisplay] = useState("");
  const wasPendingRef = useRef(pending);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (pending) {
      setDisplay("");
      wasPendingRef.current = true;
      return;
    }

    const shouldType = wasPendingRef.current && Boolean(title);
    wasPendingRef.current = false;

    if (!title) {
      setDisplay("");
      return;
    }

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!shouldType || reduced) {
      setDisplay(title);
      return;
    }

    setDisplay("");
    let index = 0;
    const tick = () => {
      index += 1;
      setDisplay(title.slice(0, index));
      if (index < title.length) {
        timerRef.current = setTimeout(tick, CHAR_MS);
      }
    };
    timerRef.current = setTimeout(tick, CHAR_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pending, title]);

  if (pending) {
    return (
      <Tag
        className={`${className} topic-title-skeleton`.trim()}
        aria-busy="true"
        aria-label="Generating topic title"
      />
    );
  }

  if (!title) return null;

  return <Tag className={className}>{display}</Tag>;
}
