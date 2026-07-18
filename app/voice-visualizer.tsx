"use client";

import { useEffect, useRef } from "react";

const BAR_COUNT = 24;

type Props = {
  active: boolean;
  /** Live frequency data when available; null → decorative CSS bars (iOS). */
  analyser?: AnalyserNode | null;
};

/**
 * Composer mic visualizer. Uses AnalyserNode levels when the voice hook supplies
 * one; otherwise CSS animation (iOS / meter unavailable).
 */
export function VoiceVisualizer({ active, analyser }: Props) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const live = Boolean(active && analyser);

  useEffect(() => {
    if (!live || !analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    let cancelled = false;

    const draw = () => {
      if (cancelled) return;
      analyser.getByteFrequencyData(data);
      const bars = barsRef.current;
      const step = Math.max(1, Math.floor(data.length / bars.length));
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        if (!bar) continue;
        const sample = data[Math.min(i * step, data.length - 1)] ?? 0;
        bar.style.transform = `scaleY(${0.08 + (sample / 255) * 0.92})`;
      }
      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [live, analyser]);

  if (!active) return null;

  return (
    <div className={`voice-visualizer${live ? " live" : ""}`} aria-hidden="true">
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          style={live ? undefined : { animationDelay: `${(i % 8) * 0.08}s` }}
        />
      ))}
    </div>
  );
}
