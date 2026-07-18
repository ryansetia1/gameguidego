import { prefersChunkedSpeechRecognition } from "./voice.js";

/**
 * Live mic levels via Web Audio. Acquire getUserMedia *before*
 * SpeechRecognition.start() — a second capture after recognition owns the mic
 * was what broke phones. iOS/WebKit still conflicts with dual sessions, so we
 * skip live metering there and fall back to CSS bars in the visualizer.
 *
 * @typedef {{
 *   stream: MediaStream,
 *   audioContext: AudioContext,
 *   analyser: AnalyserNode,
 *   release: () => void,
 * }} VoiceMeter
 */

/** @returns {boolean} */
export function supportsLiveVoiceMeter() {
  if (typeof navigator === "undefined") return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  if (prefersChunkedSpeechRecognition()) return false;
  return true;
}

/**
 * @returns {Promise<VoiceMeter | null>}
 */
export async function createVoiceMeter() {
  if (!supportsLiveVoiceMeter()) return null;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  /** @type {typeof AudioContext | undefined} */
  const Ctx =
    typeof window !== "undefined"
      ? window.AudioContext ||
        /** @type {any} */ (window).webkitAudioContext
      : undefined;
  if (!Ctx) {
    stream.getTracks().forEach((track) => track.stop());
    return null;
  }
  const audioContext = new Ctx();
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.8;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  return {
    stream,
    audioContext,
    analyser,
    release() {
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close().catch(() => {});
    },
  };
}

/** @param {VoiceMeter | null | undefined} meter */
export function releaseVoiceMeter(meter) {
  meter?.release();
}
