"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";

import { SPOILER_TOGGLE_LABEL } from "@/lib/spoiler-prefs.js";
import { VOICE_LANGUAGES } from "@/lib/voice.js";
import { IconArrowLeft, IconPlus, IconStop } from "./icons";
import { useVoiceInput } from "./voice-input";

type Props = {
  user: User | null;
  disabled?: boolean;
  attachDisabled?: boolean;
  /** Show Photo/Camera items (signed-in only; anon has no Storage). */
  canAttach?: boolean;
  /** Show the Voice input item (browser supports Web Speech). */
  voiceSupported?: boolean;
  temporary?: boolean;
  onToggleTemporary?: () => void;
  spoilerMajor?: boolean;
  onToggleSpoiler?: () => void;
  /** Show guide retrieval toggles when a preferred guide is attached. */
  showGuideRetrievalToggles?: boolean;
  guideRetrievalMode?: "default" | "skip" | "supplement";
  onToggleSkipGuide?: () => void;
  onToggleSupplementGuide?: () => void;
  onTranscript: (text: string) => void;
  onListeningChange?: (listening: boolean) => void;
  onSelectImages: (files: FileList | null) => void;
};

/**
 * The single composer "+" control for every user and viewport: one button opens
 * attach (signed-in) + voice + temporary-chat options so the textarea keeps room
 * beside Send.
 */
export function ComposerExtras({
  user,
  disabled,
  attachDisabled,
  canAttach,
  voiceSupported,
  temporary,
  onToggleTemporary,
  spoilerMajor = false,
  onToggleSpoiler,
  showGuideRetrievalToggles,
  guideRetrievalMode = "default",
  onToggleSkipGuide,
  onToggleSupplementGuide,
  onTranscript,
  onListeningChange,
  onSelectImages,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"main" | "lang">("main");
  const wrapRef = useRef<HTMLDivElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const voice = useVoiceInput({ user, disabled, onTranscript, onListeningChange });

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
        title={voice.listening ? "Stop listening" : "More options"}
        aria-label={voice.listening ? "Stop listening" : "More options"}
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
              {canAttach && (
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
                </>
              )}
              {voiceSupported && (
                <button type="button" role="menuitem" onClick={handleVoiceClick}>
                  Voice input
                </button>
              )}
              {showGuideRetrievalToggles && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-extras-toggle"
                    aria-pressed={guideRetrievalMode === "skip"}
                    onClick={() => {
                      onToggleSkipGuide?.();
                      setMenuOpen(false);
                      setMenuView("main");
                    }}
                  >
                    Search web instead
                    <span
                      className={`composer-extras-state${guideRetrievalMode === "skip" ? " on" : ""}`}
                    >
                      {guideRetrievalMode === "skip" ? "On" : "Off"}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-extras-toggle"
                    aria-pressed={guideRetrievalMode === "supplement"}
                    onClick={() => {
                      onToggleSupplementGuide?.();
                      setMenuOpen(false);
                      setMenuView("main");
                    }}
                  >
                    Also search web
                    <span
                      className={`composer-extras-state${guideRetrievalMode === "supplement" ? " on" : ""}`}
                    >
                      {guideRetrievalMode === "supplement" ? "On" : "Off"}
                    </span>
                  </button>
                </>
              )}
              <button
                type="button"
                role="menuitem"
                className="composer-extras-toggle"
                aria-pressed={temporary}
                onClick={() => {
                  onToggleTemporary?.();
                  setMenuOpen(false);
                  setMenuView("main");
                }}
              >
                Temporary chat
                <span className={`composer-extras-state${temporary ? " on" : ""}`}>
                  {temporary ? "On" : "Off"}
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="composer-extras-toggle"
                aria-pressed={spoilerMajor}
                onClick={() => {
                  onToggleSpoiler?.();
                  setMenuOpen(false);
                  setMenuView("main");
                }}
              >
                {SPOILER_TOGGLE_LABEL}
                <span
                  className={`composer-extras-state spoiler-on${spoilerMajor ? " on" : ""}`}
                >
                  {spoilerMajor ? "On" : "Off"}
                </span>
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
