"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";

import { VOICE_LANGUAGES } from "@/lib/voice.js";
import { IconArrowLeft, IconPlus, IconStop } from "./icons";
import { useVoiceInput } from "./voice-input";

type Props = {
  user: User | null;
  disabled?: boolean;
  attachDisabled?: boolean;
  onTranscript: (text: string) => void;
  onListeningChange?: (listening: boolean) => void;
  onMeterChange?: (analyser: AnalyserNode | null) => void;
  onSelectImages: (files: FileList | null) => void;
};

/**
 * Mobile-only composer control: one "+" button opens attach + voice options so
 * the textarea keeps room beside Send. Desktop keeps separate attach/mic buttons.
 */
export function ComposerExtras({
  user,
  disabled,
  attachDisabled,
  onTranscript,
  onListeningChange,
  onMeterChange,
  onSelectImages,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"main" | "lang">("main");
  const wrapRef = useRef<HTMLDivElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const voice = useVoiceInput({ user, disabled, onTranscript, onListeningChange, onMeterChange });

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setMenuView("main");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!voice.listening) return;
    setMenuOpen(false);
    setMenuView("main");
  }, [voice.listening]);

  function handleMainClick() {
    if (voice.listening) {
      voice.stop();
      return;
    }
    setMenuView("main");
    setMenuOpen((open) => !open);
  }

  function handleVoiceClick() {
    if (!voice.lang) {
      setMenuView("lang");
      return;
    }
    setMenuOpen(false);
    setMenuView("main");
    voice.start(voice.lang);
  }

  function pickLanguage(code: string) {
    voice.pickLanguage(code);
    setMenuOpen(false);
    setMenuView("main");
  }

  return (
    <div className="composer-attach-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`composer-attach composer-extras${voice.listening ? " listening" : ""}`}
        title={voice.listening ? "Stop listening" : "Add photo or voice"}
        aria-label={voice.listening ? "Stop listening" : "Add photo or voice"}
        aria-pressed={voice.listening}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={handleMainClick}
      >
        {voice.listening ? <IconStop /> : <IconPlus />}
      </button>
      {menuOpen && (
        <div className="composer-attach-menu" role="menu">
          {menuView === "main" ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={attachDisabled}
                onClick={() => {
                  galleryInputRef.current?.click();
                  setMenuOpen(false);
                }}
              >
                Photo library
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={attachDisabled}
                onClick={() => {
                  cameraInputRef.current?.click();
                  setMenuOpen(false);
                }}
              >
                Camera
              </button>
              <button type="button" role="menuitem" onClick={handleVoiceClick}>
                Voice input
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className="composer-extras-back icon-inline"
                onClick={() => setMenuView("main")}
              >
                <IconArrowLeft size={16} /> Back
              </button>
              {VOICE_LANGUAGES.map((entry) => (
                <button
                  key={entry.code}
                  type="button"
                  role="menuitem"
                  onClick={() => pickLanguage(entry.code)}
                >
                  {entry.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        disabled={disabled || attachDisabled}
        onChange={(event) => {
          onSelectImages(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        disabled={disabled || attachDisabled}
        onChange={(event) => {
          onSelectImages(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
