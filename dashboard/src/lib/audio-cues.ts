/**
 * Audio cues for voice input state changes.
 * Uses Web Audio API to generate simple tones — no external audio files needed.
 *
 * Cues:
 * - ready:        double ding (high) — mic calibrated, ready to listen
 * - speechEnd:    single ding (mid) — speech ended, transcribing
 * - transcribed:  single ding (low) — transcription complete
 * - wakeActivate: ascending double ding — wake word detected
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  // Resume if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(frequency: number, duration: number, startTime: number, volume = 0.15) {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.value = frequency;

  // Soft envelope to avoid clicks
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

/** Double ding — mic ready to listen */
export function cueReady() {
  if (!audioCuesEnabled) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(880, 0.12, now);       // A5
  playTone(1175, 0.15, now + 0.13); // D6
}

/** Single mid-tone ding — speech ended, processing */
export function cueSpeechEnd() {
  if (!audioCuesEnabled) return;
  const ctx = getAudioContext();
  playTone(660, 0.15, ctx.currentTime); // E5
}

/** Single low confirmation ding — transcription done */
export function cueTranscribed() {
  if (!audioCuesEnabled) return;
  const ctx = getAudioContext();
  playTone(523, 0.12, ctx.currentTime); // C5
}

/** Ascending double ding — wake word activated */
export function cueWakeActivate() {
  if (!audioCuesEnabled) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(587, 0.1, now);        // D5
  playTone(880, 0.15, now + 0.11); // A5
}

// ---------------------------------------------------------------------------
// Enable/disable setting (persisted in localStorage)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'hivecommand-audio-cues';
let audioCuesEnabled = loadSetting();

function loadSetting(): boolean {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    return val === null ? true : val === 'true'; // enabled by default
  } catch {
    return true;
  }
}

export function isAudioCuesEnabled(): boolean {
  return audioCuesEnabled;
}

export function setAudioCuesEnabled(enabled: boolean) {
  audioCuesEnabled = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch { /* ignore */ }
}
