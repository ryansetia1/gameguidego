"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";

import { getSupabase } from "@/lib/supabase";
import { warmUpMicrophone } from "@/lib/voice-meter.js";
import {
  getSpeechRecognition,
  isBenignSpeechError,
  loadVoiceLang,
  prefersChunkedSpeechRecognition,
  saveVoiceLang,
  shouldRetrySpeechError,
  SPEECH_NETWORK_RETRY_MAX,
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
 * ponytail: singleton instance (no re-new per start), delayed onend restart,
 * iOS uses continuous=false + manual restart, visibility stop on background.
 * User stop calls recognition.stop() (not abort) so finals flush; desktop keeps
 * interimResults for a last-chunk capture on stop.
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
  const listeningIntentRef = useRef(false);
  const sessionRef = useRef(0);
  const restartTimerRef = useRef(0);
  const networkRetriesRef = useRef(0);
  const lastInterimRef = useRef("");
  const stopFallbackTimerRef = useRef(0);
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

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = 0;
    }
  }, []);

  const clearStopFallback = useCallback(() => {
    if (stopFallbackTimerRef.current) {
      clearTimeout(stopFallbackTimerRef.current);
      stopFallbackTimerRef.current = 0;
    }
  }, []);

  const flushInterim = useCallback(() => {
    const pending = lastInterimRef.current.trim();
    lastInterimRef.current = "";
    if (pending) onTranscriptRef.current(pending);
  }, []);

  const finishStop = useCallback(() => {
    clearRestartTimer();
    clearStopFallback();
    recognitionRef.current = null;
    setListening(false);
    sessionRef.current += 1;
  }, [clearRestartTimer, clearStopFallback]);

  const hardTeardown = useCallback(() => {
    clearRestartTimer();
    clearStopFallback();
    listeningIntentRef.current = false;
    networkRetriesRef.current = 0;
    lastInterimRef.current = "";
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    setListening(false);
    sessionRef.current += 1;
    try {
      recognition?.abort();
    } catch {
      // ignore
    }
  }, [clearRestartTimer, clearStopFallback]);

  const requestStop = useCallback(() => {
    clearRestartTimer();
    listeningIntentRef.current = false;
    const recognition = recognitionRef.current;
    if (!recognition) {
      setListening(false);
      return;
    }
    setListening(false);
    clearStopFallback();
    stopFallbackTimerRef.current = window.setTimeout(() => {
      stopFallbackTimerRef.current = 0;
      if (recognitionRef.current !== recognition) return;
      flushInterim();
      finishStop();
    }, 750);
    try {
      // stop() lets the engine flush a final result; abort() drops it.
      recognition.stop();
    } catch {
      flushInterim();
      try {
        recognition.abort();
      } catch {
        // ignore
      }
      finishStop();
    }
  }, [clearRestartTimer, clearStopFallback, flushInterim, finishStop]);

  const stop = useCallback(() => {
    requestStop();
  }, [requestStop]);

  stopRef.current = stop;

  useEffect(() => {
    if (!disabled || !listeningIntentRef.current) return;
    stopRef.current();
  }, [disabled]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "hidden" && listeningIntentRef.current) {
        stopRef.current();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    return () => {
      clearRestartTimer();
      clearStopFallback();
      sessionRef.current += 1;
      listeningIntentRef.current = false;
      try {
        recognitionRef.current?.abort();
      } catch {
        // already stopped
      }
      recognitionRef.current = null;
    };
  }, [clearRestartTimer, clearStopFallback]);

  function getRecognitionInstance(SpeechRecognition: new () => any) {
    if (!recognitionRef.current) {
      recognitionRef.current = new SpeechRecognition();
    }
    return recognitionRef.current;
  }

  function scheduleRestart(recognition: any, session: number) {
    clearRestartTimer();
    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = 0;
      if (
        session !== sessionRef.current ||
        !listeningIntentRef.current ||
        recognitionRef.current !== recognition
      ) {
        return;
      }
      try {
        recognition.start();
      } catch {
        if (session !== sessionRef.current) return;
        hardTeardown();
      }
    }, SPEECH_RESTART_MS);
  }

  function bindRecognition(recognition: any, session: number, code: string) {
    const chunked = prefersChunkedSpeechRecognition();
    recognition.lang = code;
    recognition.interimResults = !chunked;
    recognition.continuous = !chunked;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event: any) => {
      if (session !== sessionRef.current) return;
      networkRetriesRef.current = 0;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i];
        const transcript = chunk[0]?.transcript;
        if (typeof transcript !== "string" || !transcript.trim()) continue;
        const text = transcript.trim();
        if (chunk.isFinal) {
          lastInterimRef.current = "";
          onTranscriptRef.current(text);
        } else {
          lastInterimRef.current = text;
        }
      }
    };
    recognition.onerror = (event: any) => {
      if (session !== sessionRef.current) return;
      const err = event?.error;
      if (isBenignSpeechError(err)) return;
      if (shouldRetrySpeechError(err) && listeningIntentRef.current) {
        if (err === "network") {
          networkRetriesRef.current += 1;
          if (networkRetriesRef.current > SPEECH_NETWORK_RETRY_MAX) {
            hardTeardown();
            return;
          }
        }
        scheduleRestart(recognition, session);
        return;
      }
      hardTeardown();
    };
    recognition.onend = () => {
      if (session !== sessionRef.current) return;
      if (!listeningIntentRef.current) {
        flushInterim();
        finishStop();
        return;
      }
      scheduleRestart(recognition, session);
    };
  }

  async function start(code: string) {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition || !code || disabled) return;
    clearRestartTimer();
    sessionRef.current += 1;
    const session = sessionRef.current;
    networkRetriesRef.current = 0;
    lastInterimRef.current = "";
    try {
      recognitionRef.current?.abort();
    } catch {
      // ignore
    }
    await warmUpMicrophone();
    if (session !== sessionRef.current) return;
    const recognition = getRecognitionInstance(SpeechRecognition);
    bindRecognition(recognition, session, code);
    listeningIntentRef.current = true;
    try {
      recognition.start();
      setListening(true);
    } catch {
      if (session !== sessionRef.current) return;
      hardTeardown();
    }
  }

  function pickLanguage(code: string) {
    setLang(code);
    saveVoiceLang(code);
    if (user) void persistVoiceLangForUser(code);
    setPickerOpen(false);
    void start(code);
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
    void start(lang);
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
