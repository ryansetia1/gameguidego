"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";

import { getSupabase } from "@/lib/supabase";
import {
  getSpeechRecognition,
  loadVoiceLang,
  saveVoiceLang,
  VOICE_LANGUAGES,
  voiceLangFromUserMetadata,
} from "@/lib/voice.js";

type Props = {
  user: User | null;
  disabled?: boolean;
  onTranscript: (text: string) => void;
};

async function persistVoiceLangForUser(code: string) {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.auth.updateUser({ data: { voice_lang: code || null } });
  } catch (error) {
    console.error("Failed to save voice language:", error);
  }
}

/**
 * Mic button (Web Speech API). Free browser dictation, so we set the chosen
 * BCP-47 language on the recognizer before starting. First click with no saved
 * language opens a picker; after that a click starts/stops listening. The mic
 * permission prompt only appears when the user starts recognition (a click),
 * never on page load. Available to all users; signed-in users' choice syncs to
 * user_metadata. Hidden entirely when the browser has no SpeechRecognition.
 *
 * ponytail: final-result only (interimResults/continuous off) for stability
 * across devices — iOS Safari drops interim results. Upgrade to live interim
 * later by flipping interimResults/continuous and streaming onresult chunks.
 */
export function VoiceInput({ user, disabled, onTranscript }: Props) {
  const [supported, setSupported] = useState(false);
  const [lang, setLang] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // Detect after mount to avoid an SSR/client hydration mismatch.
  useEffect(() => {
    setSupported(Boolean(getSpeechRecognition()));
    setLang(loadVoiceLang());
  }, []);

  // Signed-in users: adopt the language saved on the account.
  useEffect(() => {
    if (!user) return;
    const remote = voiceLangFromUserMetadata(user.user_metadata);
    if (remote) {
      setLang(remote);
      saveVoiceLang(remote);
    }
  }, [user]);

  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen]);

  // Stop any in-flight recognition on unmount.
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        // already stopped
      }
    };
  }, []);

  function start(code: string) {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition || !code) return;
    try {
      recognitionRef.current?.abort();
    } catch {
      // ignore
    }
    const recognition = new SpeechRecognition();
    recognition.lang = code;
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (typeof transcript === "string" && transcript.trim()) {
        onTranscript(transcript.trim());
      }
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start(); // triggers the mic permission prompt on first use
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  function pickLanguage(code: string) {
    setLang(code);
    saveVoiceLang(code);
    if (user) void persistVoiceLangForUser(code);
    setPickerOpen(false);
    start(code);
  }

  function handleClick() {
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      setListening(false);
      return;
    }
    if (!lang) {
      setPickerOpen((open) => !open);
      return;
    }
    start(lang);
  }

  if (!supported) return null;

  return (
    <div className="composer-attach-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`composer-attach composer-mic${listening ? " listening" : ""}`}
        title={listening ? "Stop listening" : "Voice input"}
        aria-label={listening ? "Stop listening" : "Voice input"}
        aria-expanded={pickerOpen}
        aria-haspopup={lang ? undefined : "menu"}
        disabled={disabled}
        onClick={handleClick}
      >
        <span aria-hidden="true">{listening ? "■" : "🎙"}</span>
      </button>
      {pickerOpen && (
        <div className="composer-attach-menu composer-lang-menu" role="menu">
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
        </div>
      )}
    </div>
  );
}
