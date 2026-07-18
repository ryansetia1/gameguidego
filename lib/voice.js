/**
 * Voice-input (Web Speech API) language preference. Free browser feature, so the
 * chosen BCP-47 tag must be set on the SpeechRecognition instance before use.
 * Persisted per-device in localStorage and, for signed-in users, in
 * `user_metadata.voice_lang`. Mirrors lib/theme.js.
 *
 * @typedef {{ code: string, label: string }} VoiceLanguage
 */

export const VOICE_LANG_KEY = "gg:voice-lang";

/**
 * Popular languages only — Web Speech recognition supports far more, but a short
 * list keeps the first-use picker glanceable. Extend as needed.
 * @type {VoiceLanguage[]}
 */
export const VOICE_LANGUAGES = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "id-ID", label: "Bahasa Indonesia" },
  { code: "es-ES", label: "Español" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "it-IT", label: "Italiano" },
  { code: "ru-RU", label: "Русский" },
  { code: "ja-JP", label: "日本語" },
  { code: "ko-KR", label: "한국어" },
  { code: "zh-CN", label: "中文 (普通话)" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "ar-SA", label: "العربية" },
];

const VALID = new Set(VOICE_LANGUAGES.map((entry) => entry.code));

/** @param {unknown} value @returns {string} valid code or "" */
export function coerceVoiceLang(value) {
  return typeof value === "string" && VALID.has(value) ? value : "";
}

/** @param {string} code @returns {string} human label or the raw code */
export function voiceLangLabel(code) {
  return VOICE_LANGUAGES.find((entry) => entry.code === code)?.label ?? code;
}

/** @param {unknown} metadata @returns {string} */
export function voiceLangFromUserMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  return coerceVoiceLang(/** @type {Record<string, unknown>} */ (metadata).voice_lang);
}

/** @returns {string} stored code or "" when unset/private mode */
export function loadVoiceLang() {
  if (typeof window === "undefined") return "";
  try {
    return coerceVoiceLang(window.localStorage.getItem(VOICE_LANG_KEY));
  } catch {
    return "";
  }
}

/** @param {string} code */
export function saveVoiceLang(code) {
  if (typeof window === "undefined") return;
  const valid = coerceVoiceLang(code);
  try {
    if (valid) window.localStorage.setItem(VOICE_LANG_KEY, valid);
    else window.localStorage.removeItem(VOICE_LANG_KEY);
  } catch {
    // quota/private mode
  }
}

/**
 * The SpeechRecognition constructor, or null when the browser lacks it
 * (Firefox has none; feature-detect so the mic button can hide).
 * @returns {(new () => any) | null}
 */
export function getSpeechRecognition() {
  if (typeof window === "undefined") return null;
  return (
    /** @type {any} */ (window).SpeechRecognition ||
    /** @type {any} */ (window).webkitSpeechRecognition ||
    null
  );
}

/** Delay before restarting after onend — avoids InvalidStateError races (Chrome/iOS). */
export const SPEECH_RESTART_MS = 250;

/** Max automatic retries after transient network errors before giving up. */
export const SPEECH_NETWORK_RETRY_MAX = 3;

/**
 * iOS/WebKit is more stable with continuous off + manual restart than
 * continuous on (buffer clogging / stop races). Desktop Chrome tolerates both.
 * @returns {boolean}
 */
export function prefersChunkedSpeechRecognition() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * @param {string} error SpeechRecognitionErrorEvent.error
 * @returns {boolean}
 */
export function shouldRetrySpeechError(error) {
  return error === "no-speech" || error === "network";
}

/** @param {string} error @returns {boolean} */
export function isBenignSpeechError(error) {
  return error === "aborted";
}
