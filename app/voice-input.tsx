"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";

import { getSupabase } from "@/lib/supabase";
import { warmUpMicrophone } from "@/lib/voice-meter.js";
import {
  getSpeechRecognition,
  loadVoiceLang,
  prefersChunkedSpeechRecognition,
  saveVoiceLang,
  SPEECH_RESTART_MS,
  VOICE_LANGUAGES,
  voiceLangFromUserMetadata,
} from "@/lib/voice.js";
import { IconMic, IconStop } from "./icons";

type VoiceInputOptions = {
  user: User | null;
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onListeningChange?: (listening: boolean) => void;
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
 * Shared Web Speech dictation for the mic button and mobile composer-extras menu.
 *
 * Recognition settings match the stable e469d89 path (final-only, results[0]).
 * Transcript is buffered while listening and appended to the composer once on stop.
 * iOS keeps continuous=false and auto-restarts between phrases; desktop uses
 * continuous=true and rebuilds one string from all final segments each onresult.
 */
export function useVoiceInput({
  user,
  disabled,
  onTranscript,
  onListeningChange,
}: VoiceInputOptions) {
  const [supported, setSupported] = useState(false);
  const [lang, setLang] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const listeningRef = useRef(false);
  const restartTimerRef = useRef(0);
  const stopFallbackRef = useRef(0);
  // Desktop: one rebuilt string from cumulative finals. iOS: one phrase per cycle.
  const bufferRef = useRef("");
  const partsRef = useRef<string[]>([]);
  const onTranscriptRef = useRef(onTranscript);
  const onListeningChangeRef = useRef(onListeningChange);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    onListeningChangeRef.current = onListeningChange;
  }, [onListeningChange]);

  useEffect(() => {
    onListeningChangeRef.current?.(listening);
  }, [listening]);

  useEffect(() => {
    setSupported(Boolean(getSpeechRecognition()));
    setLang(loadVoiceLang());
  }, []);

  useEffect(() => {
    if (!user) return;
    const remote = voiceLangFromUserMetadata(user.user_metadata);
    if (remote) {
      setLang(remote);
      saveVoiceLang(remote);
    }
  }, [user]);

  useEffect(() => {
    return () => {
      listeningRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (stopFallbackRef.current) clearTimeout(stopFallbackRef.current);
      try {
        recognitionRef.current?.abort();
      } catch {
        // already stopped
      }
      recognitionRef.current = null;
    };
  }, []);

  function clearBuffer() {
    bufferRef.current = "";
    partsRef.current = [];
  }

  function bufferedText() {
    if (prefersChunkedSpeechRecognition()) {
      return partsRef.current.join(" ").trim();
    }
    return bufferRef.current.trim();
  }

  function flushBuffer() {
    const text = bufferedText();
    clearBuffer();
    if (text) onTranscriptRef.current(text);
  }

  function clearStopFallback() {
    if (stopFallbackRef.current) {
      clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = 0;
    }
  }

  function captureResult(event: any) {
    const results = event?.results;
    if (!results?.length) return;

    if (prefersChunkedSpeechRecognition()) {
      // e469d89: first final only — one clean phrase per recognition cycle.
      const transcript = results[0]?.[0]?.transcript;
      if (typeof transcript !== "string" || !transcript.trim()) return;
      const text = transcript.trim();
      const parts = partsRef.current;
      if (parts[parts.length - 1] !== text) parts.push(text);
      return;
    }

    // Desktop continuous: replace with the full final transcript so far (no append).
    let text = "";
    for (let i = 0; i < results.length; i++) {
      if (results[i].isFinal) text += results[i][0]?.transcript ?? "";
    }
    bufferRef.current = text.trim();
  }

  function attachRecognition(recognition: any, code: string) {
    const chunked = prefersChunkedSpeechRecognition();
    recognition.lang = code;
    recognition.interimResults = false;
    recognition.continuous = !chunked;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event: any) => captureResult(event);
    recognition.onerror = () => {
      listeningRef.current = false;
      setListening(false);
    };
    recognition.onend = () => {
      clearStopFallback();
      if (listeningRef.current) {
        if (chunked) {
          if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
          restartTimerRef.current = window.setTimeout(() => {
            restartTimerRef.current = 0;
            if (!listeningRef.current) return;
            beginListening(code, false);
          }, SPEECH_RESTART_MS);
        }
        return;
      }
      flushBuffer();
      recognitionRef.current = null;
      setListening(false);
    };
  }

  function beginListening(code: string, warmMic: boolean) {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition || !code || disabled || !listeningRef.current) return;

    try {
      recognitionRef.current?.abort();
    } catch {
      // ignore
    }

    void (async () => {
      if (warmMic) await warmUpMicrophone();
      if (!listeningRef.current) return;

      const recognition = new SpeechRecognition();
      attachRecognition(recognition, code);
      recognitionRef.current = recognition;
      try {
        recognition.start();
        setListening(true);
      } catch {
        listeningRef.current = false;
        setListening(false);
      }
    })();
  }

  function start(code: string) {
    clearBuffer();
    listeningRef.current = true;
    beginListening(code, true);
  }

  function stop() {
    listeningRef.current = false;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = 0;
    }
    const recognition = recognitionRef.current;
    setListening(false);
    clearStopFallback();
    stopFallbackRef.current = window.setTimeout(() => {
      stopFallbackRef.current = 0;
      if (recognitionRef.current !== recognition) return;
      flushBuffer();
      try {
        recognition?.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }, 750);
    try {
      recognition?.stop();
    } catch {
      flushBuffer();
      recognitionRef.current = null;
    }
  }

  stopRef.current = stop;

  useEffect(() => {
    if (!disabled || !listeningRef.current) return;
    stopRef.current();
  }, [disabled]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "hidden" && listeningRef.current) {
        stopRef.current();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  function pickLanguage(code: string) {
    setLang(code);
    saveVoiceLang(code);
    if (user) void persistVoiceLangForUser(code);
    setPickerOpen(false);
    start(code);
  }

  function handleClick() {
    if (listening) {
      stop();
      return;
    }
    if (!lang) {
      setPickerOpen((open) => !open);
      return;
    }
    start(lang);
  }

  return {
    supported,
    lang,
    listening,
    pickerOpen,
    setPickerOpen,
    start,
    stop,
    handleClick,
    pickLanguage,
  };
}

type Props = VoiceInputOptions;

/**
 * Mic button (Web Speech API). Free browser dictation; permission prompts only
 * on click. Hidden when the browser lacks SpeechRecognition (e.g. Firefox).
 */
export function VoiceInput({ user, disabled, onTranscript, onListeningChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { supported, lang, listening, pickerOpen, setPickerOpen, handleClick, pickLanguage } =
    useVoiceInput({ user, disabled, onTranscript, onListeningChange });

  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen, setPickerOpen]);

  if (!supported) return null;

  return (
    <div className="composer-attach-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`composer-attach composer-mic${listening ? " listening" : ""}`}
        title={listening ? "Stop listening" : "Voice input"}
        aria-label={listening ? "Stop listening" : "Voice input"}
        aria-pressed={listening}
        aria-expanded={pickerOpen}
        aria-haspopup={lang ? undefined : "menu"}
        disabled={disabled}
        onClick={handleClick}
      >
        {listening ? <IconStop /> : <IconMic />}
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
