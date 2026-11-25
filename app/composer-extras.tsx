"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { SPOILER_TOGGLE_LABEL } from "@/lib/spoiler-prefs.js";
import { VOICE_LANGUAGES } from "@/lib/voice.js";
import { IconArrowLeft, IconCheck, IconPlus, IconStop } from "./icons";
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
  guideRetrievalMode?: "default" | "skip" | "supplement" | "knowledge";
  onToggleSkipGuide?: () => void;
  onToggleSupplementGuide?: () => void;
  onToggleKnowledgeOnly?: () => void;
  /** Opens the Maps panel; set only while a game is active. */
  onOpenMaps?: () => void;
  /** Saved maps for the active game, shown as "Maps (N)". */
  mapsCount?: number;
  onTranscript: (text: string) => void;
  onListeningChange?: (listening: boolean) => void;
  onSelectImages: (files: FileList | null) => void;
};

/**
 * Toggle row in the "+" menu: square checkbox on the right. The menu stays open
 * so the player sees the box flip (#50).
 */
function MenuToggle({
  role = "menuitemcheckbox",
  checked,
  onToggle,
  children,
}: {
  role?: "menuitemcheckbox" | "menuitemradio";
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      className="composer-extras-toggle"
      onClick={onToggle}
    >
      {children}
      <span className={`composer-extras-check${checked ? " checked" : ""}`} aria-hidden="true">
        {checked && <IconCheck size={14} />}
      </span>
    </button>
  );
}

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
  onToggleKnowledgeOnly,
  onOpenMaps,
  mapsCount = 0,
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

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Move focus into the menu when it opens or switches view (keyboard access).
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>("[role^='menuitem']:not(:disabled)")?.focus();
  }, [menuOpen, menuView]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!menuOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
      setMenuView("main");
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)") ?? [],
    );
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  }

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
    <div className="composer-attach-wrap" ref={wrapRef} onKeyDown={handleMenuKeyDown}>
      <button
        ref={triggerRef}
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
        <div className="composer-attach-menu" role="menu" ref={menuRef}>
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
              {onOpenMaps && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setMenuView("main");
                    // Focus "+" first so the panel returns focus here when it closes.
                    triggerRef.current?.focus();
                    onOpenMaps();
                  }}
                >
                  Maps{mapsCount > 0 ? ` (${mapsCount})` : ""}
                </button>
              )}
              {showGuideRetrievalToggles && (
                <div
                  className="composer-extras-group"
                  role="group"
                  aria-label="Answer source"
                >
                  <span
                    className="composer-extras-group-label"
                    aria-hidden="true"
                  >
                    Answer source
                  </span>
                  <MenuToggle
                    role="menuitemradio"
                    checked={guideRetrievalMode === "skip"}
                    onToggle={() => onToggleSkipGuide?.()}
                  >
                    Search web instead
                  </MenuToggle>
                  <MenuToggle
                    role="menuitemradio"
                    checked={guideRetrievalMode === "supplement"}
                    onToggle={() => onToggleSupplementGuide?.()}
                  >
                    Guide + web search
                  </MenuToggle>
                  <MenuToggle
                    role="menuitemradio"
                    checked={guideRetrievalMode === "knowledge"}
                    onToggle={() => onToggleKnowledgeOnly?.()}
                  >
                    Knowledge only
                  </MenuToggle>
                </div>
              )}
              <MenuToggle checked={!!temporary} onToggle={() => onToggleTemporary?.()}>
                Temporary chat
              </MenuToggle>
              <MenuToggle checked={spoilerMajor} onToggle={() => onToggleSpoiler?.()}>
                {SPOILER_TOGGLE_LABEL}
              </MenuToggle>
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
