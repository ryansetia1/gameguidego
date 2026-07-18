"use client";

const BAR_COUNT = 24;

/**
 * Decorative mic bars over the composer while voice input runs. CSS-only —
 * SpeechRecognition already owns the mic; a second getUserMedia stream for live
 * levels was killing recognition on phones.
 */
export function VoiceVisualizer({ active }: { active: boolean }) {
  if (!active) return null;

  return (
    <div className="voice-visualizer" aria-hidden="true">
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <span key={i} style={{ animationDelay: `${(i % 8) * 0.08}s` }} />
      ))}
    </div>
  );
}
