import { create } from 'zustand';
import { isDesktop, invoke, listen } from './tauri';
import { emitVoiceCommand } from './voice-commands';
import type { VoiceCommandPayload } from './voice-commands';
import { cueReady, cueSpeechEnd, cueTranscribed, cueWakeActivate } from './audio-cues';

// ---------------------------------------------------------------------------
// Types (mirror Rust payloads)
// ---------------------------------------------------------------------------

export interface ModelStatus {
  installed: boolean;
  modelSize: string;
  path: string;
  sizeBytes: number | null;
  active: boolean;
}

export interface SttStatus {
  mode: 'off' | 'global' | 'push-to-talk' | 'wake-word';
  modelLoaded: boolean;
  modelSize: string;
  speaking: boolean;
  wakeWordPhase: 'passive' | 'active' | null;
}

interface TranscriptionPayload {
  text: string;
  isFinal: boolean;
}

interface VadStatusPayload {
  speaking: boolean;
}

interface DownloadProgressPayload {
  percent: number;
  bytesDone: number;
  bytesTotal: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SpeechStore {
  // Availability
  available: boolean;

  // State
  micMode: 'off' | 'global' | 'push-to-talk' | 'wake-word';
  micReady: boolean; // true after VAD calibration completes
  modelInstalled: boolean;
  modelLoaded: boolean;
  modelSize: string;
  backend: 'local' | 'openai' | 'groq';
  openaiApiKey: string;
  groqApiKey: string;
  smartMatching: boolean;
  speaking: boolean;
  transcribing: boolean; // true while whisper is processing audio
  lastTranscription: string;

  // Wake word
  wakeWordPhase: 'passive' | 'active' | null; // null when not in wake-word mode
  wakePhrase: string;

  // Dictation mode (started via "start transcribe" voice command)
  dictationMode: boolean;
  // True when dictation was started from command mode (should return to command mode on stop)
  commandModeActive: boolean;
  // The mic mode that was active before dictation started (to return to after stop)
  preDictationMode: 'off' | 'global' | 'push-to-talk' | 'wake-word';

  // Download
  downloadProgress: number | null; // 0-100 or null
  showDownloadModal: boolean;
  pendingMode: 'global' | 'push-to-talk' | null; // mode to start after download

  // Whisper install
  whisperInstallStage: string | null; // 'downloading' | 'extracting' | 'building' | 'done' | 'error' | null
  whisperInstallPercent: number | null;
  whisperInstallMessage: string | null;

  // Enter key signal (incremented to trigger Enter in active terminal)
  pendingEnter: number;

  // Utterance timing
  silenceTimeoutMs: number;

  // Error
  error: string | null;

  // Actions
  setMicMode: (mode: 'off' | 'global' | 'push-to-talk' | 'wake-word') => void;
  setMicReady: (v: boolean) => void;
  setModelInstalled: (v: boolean) => void;
  setModelLoaded: (v: boolean) => void;
  setSpeaking: (v: boolean) => void;
  setTranscribing: (v: boolean) => void;
  setLastTranscription: (text: string) => void;
  setWakeWordPhase: (phase: 'passive' | 'active' | null) => void;
  setWakePhrase: (phrase: string) => void;
  setDictationMode: (v: boolean) => void;
  setCommandModeActive: (v: boolean) => void;
  setPreDictationMode: (mode: 'off' | 'global' | 'push-to-talk' | 'wake-word') => void;
  setDownloadProgress: (p: number | null) => void;
  setShowDownloadModal: (v: boolean, pendingMode?: 'global' | 'push-to-talk') => void;
  setWhisperInstall: (stage: string | null, percent: number | null, message: string | null) => void;
  setSmartMatching: (v: boolean) => void;
  setSilenceTimeoutMs: (ms: number) => void;
  setBackend: (backend: 'local' | 'openai' | 'groq') => void;
  setOpenaiApiKey: (key: string) => void;
  setGroqApiKey: (key: string) => void;
  triggerEnter: () => void;
  setError: (e: string | null) => void;
}

export const useSpeechStore = create<SpeechStore>((set) => ({
  available: isDesktop,
  micMode: 'off',
  micReady: false,
  modelInstalled: false,
  modelLoaded: false,
  modelSize: 'small',
  backend: 'local',
  openaiApiKey: '',
  groqApiKey: '',
  smartMatching: true,
  speaking: false,
  transcribing: false,
  lastTranscription: '',
  wakeWordPhase: null,
  wakePhrase: 'hey hivecommand',
  dictationMode: false,
  commandModeActive: false,
  preDictationMode: 'off',
  downloadProgress: null,
  showDownloadModal: false,
  pendingMode: null,
  whisperInstallStage: null,
  whisperInstallPercent: null,
  whisperInstallMessage: null,
  silenceTimeoutMs: 800,
  pendingEnter: 0,
  error: null,

  setMicMode: (mode) => set({ micMode: mode }),
  setMicReady: (v) => set({ micReady: v }),
  setModelInstalled: (v) => set({ modelInstalled: v }),
  setModelLoaded: (v) => set({ modelLoaded: v }),
  setSpeaking: (v) => set({ speaking: v }),
  setTranscribing: (v) => set({ transcribing: v }),
  setLastTranscription: (text) => set({ lastTranscription: text }),
  setWakeWordPhase: (phase) => set({ wakeWordPhase: phase }),
  setWakePhrase: (phrase) => set({ wakePhrase: phrase }),
  setDictationMode: (v) => set({ dictationMode: v }),
  setCommandModeActive: (v) => set({ commandModeActive: v }),
  setPreDictationMode: (mode) => set({ preDictationMode: mode }),
  setDownloadProgress: (p) => set({ downloadProgress: p }),
  setShowDownloadModal: (v, pendingMode) =>
    set({ showDownloadModal: v, pendingMode: pendingMode ?? null }),
  setWhisperInstall: (stage, percent, message) =>
    set({ whisperInstallStage: stage, whisperInstallPercent: percent, whisperInstallMessage: message }),
  setSmartMatching: (v) => set({ smartMatching: v }),
  setSilenceTimeoutMs: (ms) => set({ silenceTimeoutMs: ms }),
  setBackend: (backend) => set({ backend }),
  setOpenaiApiKey: (key) => set({ openaiApiKey: key }),
  setGroqApiKey: (key) => set({ groqApiKey: key }),
  triggerEnter: () => set((s) => ({ pendingEnter: s.pendingEnter + 1 })),
  setError: (e) => set({ error: e }),
}));

// ---------------------------------------------------------------------------
// Transcription callback registry
// ---------------------------------------------------------------------------

type TranscriptionCallback = (text: string) => void;
let transcriptionCallback: TranscriptionCallback | null = null;

/** Register a callback to receive transcribed text. */
export function onTranscription(cb: TranscriptionCallback) {
  transcriptionCallback = cb;
}

/** Remove the transcription callback. */
export function offTranscription() {
  transcriptionCallback = null;
}

// ---------------------------------------------------------------------------
// Tauri event listeners (initialized once)
// ---------------------------------------------------------------------------

let listenersInitialized = false;

export async function initSpeechListeners() {
  if (!isDesktop || listenersInitialized) return;
  listenersInitialized = true;

  // Load saved config (backend, API key, wake phrase)
  try {
    const config = await invoke<{ backend: string; openaiApiKey: string; groqApiKey: string; modelSize: string; wakePhrase?: string; smartMatching?: boolean; silenceTimeoutMs?: number }>('stt_get_config');
    const store = useSpeechStore.getState();
    store.setBackend(config.backend as 'local' | 'openai' | 'groq');
    store.setOpenaiApiKey(config.openaiApiKey || '');
    store.setGroqApiKey(config.groqApiKey || '');
    store.setSmartMatching(config.smartMatching !== false);
    if (config.silenceTimeoutMs) store.setSilenceTimeoutMs(config.silenceTimeoutMs);
    if (config.wakePhrase) store.setWakePhrase(config.wakePhrase);
  } catch (e) {
    console.warn('[STT] Failed to load config:', e);
  }

  // Check initial model status
  try {
    const status = await invoke<ModelStatus>('stt_check_model');
    console.log('[STT] Model status:', status);
    useSpeechStore.getState().setModelInstalled(status.installed);
  } catch (e) {
    console.warn('[STT] Failed to check model status:', e);
  }

  // Listen for transcription events
  await listen<TranscriptionPayload>('stt://transcription', (payload) => {
    const store = useSpeechStore.getState();

    // In dictation mode, check for stop commands.
    // ONLY match if the utterance IS the command (exact match or starts with it).
    // Do NOT match if command words appear inside a longer natural sentence.
    if (store.dictationMode) {
      const normalized = payload.text.toLowerCase().replace(/[^\w\s]/g, '').trim();
      const words = normalized.split(/\s+/);

      // "stop send" / "stop enter" (standalone phrases only — max 4 words)
      const stopEnterPhrases = ['stop transcribe enter', 'stop transcribing enter', 'stop dictation enter', 'end dictation enter', 'stop transcribe send', 'stop transcribing send', 'stop dictation send', 'end dictation send', 'stop send', 'stop enter'];
      if (words.length <= 4 && stopEnterPhrases.some((p) => normalized === p)) {
        console.log('[STT] Stop dictation + enter detected');
        stopDictation();
        setTimeout(() => simulateEnterKey(), 100);
        return;
      }

      // "stop" standalone or "stop transcribe" etc. — must be the whole utterance (max 3 words)
      const stopPhrases = ['stop', 'stop transcribe', 'stop transcribing', 'stop dictation', 'end dictation'];
      if (words.length <= 3 && stopPhrases.some((p) => normalized === p)) {
        console.log('[STT] Stop dictation detected');
        stopDictation();
        return;
      }
    }

    store.setLastTranscription(payload.text);
    store.setTranscribing(false);
    cueTranscribed();

    // Route to registered callback
    if (transcriptionCallback) {
      transcriptionCallback(payload.text);
    }
  });

  // Listen for voice commands
  await listen<VoiceCommandPayload>('stt://voice-command', (payload) => {
    console.log('[STT] Voice command received:', payload);
    const store = useSpeechStore.getState();
    store.setTranscribing(false);

    // Track if we're in command mode (came from wake-word active phase)
    const wasInCommandMode = store.micMode === 'wake-word' || store.commandModeActive;

    // Handle start-transcribe: switch to dictation (global) mode
    if (payload.action.kind === 'start-transcribe') {
      store.setPreDictationMode(store.micMode);
      if (wasInCommandMode) store.setCommandModeActive(true);
      startDictation();
      return;
    }

    // Handle stop-transcribe
    if (payload.action.kind === 'stop-transcribe') {
      stopDictation();
      return;
    }

    // Handle stop-transcribe-enter: stop dictation then press Enter
    if (payload.action.kind === 'stop-transcribe-enter') {
      stopDictation();
      setTimeout(() => simulateEnterKey(), 100);
      return;
    }

    // Handle press-enter: just press Enter on whatever is focused
    if (payload.action.kind === 'press-enter') {
      simulateEnterKey();
      return;
    }

    // Handle dismiss-commands: exit command mode, return to passive wake word
    if (payload.action.kind === 'dismiss-commands') {
      store.setCommandModeActive(false);
      return;
    }

    // Handle stop-listening: mic completely off
    if (payload.action.kind === 'stop-listening') {
      store.setMicMode('off');
      store.setMicReady(false);
      store.setSpeaking(false);
      store.setTranscribing(false);
      store.setWakeWordPhase(null);
      store.setCommandModeActive(false);
      store.setDictationMode(false);
      return;
    }

    // All other commands go through the voice command bus
    emitVoiceCommand(payload);
  });

  // Listen for VAD status changes
  await listen<VadStatusPayload>('stt://vad-status', (payload) => {
    useSpeechStore.getState().setSpeaking(payload.speaking);
  });

  // Listen for transcription started (whisper actually processing audio)
  await listen<void>('stt://transcribing', () => {
    useSpeechStore.getState().setTranscribing(true);
    cueSpeechEnd();
  });

  // Listen for download progress
  await listen<DownloadProgressPayload>('stt://download-progress', (payload) => {
    const store = useSpeechStore.getState();
    store.setDownloadProgress(payload.percent);

    // Download complete
    if (payload.percent >= 100) {
      // Read pendingMode BEFORE clearing the modal (which resets pendingMode)
      const pendingMode = store.pendingMode;
      store.setModelInstalled(true);
      store.setDownloadProgress(null);
      store.setShowDownloadModal(false);

      console.log('[STT] Download complete, pendingMode:', pendingMode);

      // Auto-start mic if there was a pending mode
      if (pendingMode) {
        // Small delay to let state settle
        setTimeout(() => startMic(pendingMode), 500);
      }
    }
  });

  // Listen for mic ready (VAD calibration complete)
  await listen<void>('stt://ready', () => {
    useSpeechStore.getState().setMicReady(true);
    cueReady();
  });

  // Listen for whisper binary install progress
  await listen<{ stage: string; percent: number; message: string }>('stt://whisper-install-progress', (payload) => {
    const store = useSpeechStore.getState();
    if (payload.stage === 'done') {
      store.setWhisperInstall(null, null, null);
    } else {
      store.setWhisperInstall(payload.stage, payload.percent, payload.message);
    }
  });

  // Listen for model unloaded (inactivity timeout)
  await listen<void>('stt://model-unloaded', () => {
    useSpeechStore.getState().setModelLoaded(false);
  });

  // Listen for wake word phase changes
  await listen<void>('stt://wake-word-activated', () => {
    useSpeechStore.getState().setWakeWordPhase('active');
    cueWakeActivate();
  });

  await listen<void>('stt://wake-word-passive', () => {
    useSpeechStore.getState().setWakeWordPhase('passive');
  });
}

// ---------------------------------------------------------------------------
// Actions (call Tauri commands)
// ---------------------------------------------------------------------------

/** Start the microphone in the given mode. Shows download modal if model not installed. */
export async function startMic(mode: 'global' | 'push-to-talk') {
  if (!isDesktop) return;

  const store = useSpeechStore.getState();
  console.log('[STT] startMic called, mode:', mode, 'backend:', store.backend, 'modelInstalled:', store.modelInstalled);

  // For local backend, check if model is installed
  if (store.backend === 'local' && !store.modelInstalled) {
    console.log('[STT] Model not installed, showing download modal');
    store.setShowDownloadModal(true, mode);
    return;
  }

  try {
    // Clear stale transcription so Terminal effects don't replay old text
    store.setLastTranscription('');

    // Optimistic update — show calibrating state immediately
    store.setMicReady(false);
    store.setMicMode(mode);

    await invoke('stt_start', { mode });
    store.setModelLoaded(true);
    store.setError(null);
  } catch (e) {
    // Revert on failure
    store.setMicMode('off');
    store.setMicReady(false);
    const msg = e instanceof Error ? e.message : String(e);
    store.setError(msg);
    console.error('[STT] Failed to start mic:', msg);
  }
}

/** Start wake word listening mode. */
export async function startWakeWord() {
  if (!isDesktop) return;

  const store = useSpeechStore.getState();
  try {
    store.setMicReady(false);
    store.setMicMode('wake-word');
    store.setWakeWordPhase('passive');

    await invoke('stt_start', { mode: 'wake-word' });
    store.setModelLoaded(true);
    store.setError(null);
  } catch (e) {
    store.setMicMode('off');
    store.setWakeWordPhase(null);
    store.setMicReady(false);
    const msg = e instanceof Error ? e.message : String(e);
    store.setError(msg);
    console.error('[STT] Failed to start wake word:', msg);
  }
}

/** Stop the microphone. */
export async function stopMic() {
  if (!isDesktop) return;

  try {
    await invoke('stt_stop');
    const store = useSpeechStore.getState();
    store.setMicMode('off');
    store.setMicReady(false);
    store.setSpeaking(false);
    store.setTranscribing(false);
    store.setWakeWordPhase(null);
    store.setCommandModeActive(false);
  } catch (e) {
    console.error('[STT] Failed to stop mic:', e);
  }
}

/** Toggle the mic on/off for a given mode. */
export async function toggleMic(mode: 'global' | 'push-to-talk') {
  const store = useSpeechStore.getState();
  console.log('[STT] toggleMic, current mode:', store.micMode, 'requested:', mode);
  if (store.micMode !== 'off') {
    await stopMic();
  } else {
    await startMic(mode);
  }
}

/** Toggle wake word mode on/off. */
export async function toggleWakeWord() {
  const store = useSpeechStore.getState();
  if (store.micMode !== 'off') {
    await stopMic();
  } else {
    await startWakeWord();
  }
}

/** Download a whisper model. */
export async function downloadModel(modelSize: string) {
  if (!isDesktop) return;

  try {
    useSpeechStore.getState().setDownloadProgress(0);
    await invoke('stt_download_model', { modelSize });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useSpeechStore.getState().setError(msg);
    useSpeechStore.getState().setDownloadProgress(null);
    console.error('[STT] Download failed:', msg);
  }
}

/** Force-unload the whisper model from memory. */
export async function unloadModel() {
  if (!isDesktop) return;

  try {
    await invoke('stt_unload_model');
    useSpeechStore.getState().setModelLoaded(false);
    useSpeechStore.getState().setMicMode('off');
  } catch (e) {
    console.error('[STT] Failed to unload model:', e);
  }
}

/** Set the VAD silence timeout (how long to wait after speech stops before sending). */
export async function setSilenceTimeout(ms: number) {
  if (!isDesktop) return;

  try {
    await invoke('stt_set_silence_timeout', { silenceTimeoutMs: ms });
    useSpeechStore.getState().setSilenceTimeoutMs(ms);
  } catch (e) {
    console.error('[STT] Failed to set silence timeout:', e);
  }
}

/** Save the wake phrase. */
export async function setWakePhrase(phrase: string) {
  if (!isDesktop) return;

  try {
    await invoke('stt_set_wake_phrase', { wakePhrase: phrase });
    useSpeechStore.getState().setWakePhrase(phrase);
  } catch (e) {
    console.error('[STT] Failed to set wake phrase:', e);
  }
}

/**
 * Trigger Enter key in the active terminal.
 * Uses a store signal that Terminal components watch and send \r through their WebSocket.
 */
function simulateEnterKey() {
  console.log('[STT] Triggering Enter key via store signal');
  useSpeechStore.getState().triggerEnter();
}

/**
 * Start dictation mode — stop wake word, switch to global mic.
 * Transcriptions route to the currently focused terminal.
 */
async function startDictation() {
  if (!isDesktop) return;

  const store = useSpeechStore.getState();
  console.log('[STT] Starting dictation mode');

  try {
    // Stop current mode (wake word)
    await invoke('stt_stop');

    // Clear stale transcription so Terminal effects don't replay old text
    store.setLastTranscription('');

    // Set dictation mode flag BEFORE starting global mic
    store.setDictationMode(true);
    store.setWakeWordPhase(null);
    store.setMicReady(false);
    store.setMicMode('global');

    // Start global mic mode
    await invoke('stt_start', { mode: 'global' });
    store.setModelLoaded(true);
    store.setError(null);
  } catch (e) {
    store.setDictationMode(false);
    store.setMicMode('off');
    const msg = e instanceof Error ? e.message : String(e);
    store.setError(msg);
    console.error('[STT] Failed to start dictation:', msg);
  }
}

/**
 * Stop dictation mode — return to whatever mode was active before dictation started.
 * If commandModeActive, returns to wake-word active (command) mode instead of passive.
 */
async function stopDictation() {
  if (!isDesktop) return;

  const store = useSpeechStore.getState();
  const returnToCommandMode = store.commandModeActive;
  const previousMode = store.preDictationMode;
  console.log('[STT] Stopping dictation mode, returnTo:', previousMode, 'commandMode:', returnToCommandMode);

  try {
    await invoke('stt_stop');
    store.setDictationMode(false);
    store.setMicMode('off');
    store.setMicReady(false);
    store.setSpeaking(false);
    store.setTranscribing(false);
    store.setCommandModeActive(false);

    // Return to previous mode
    setTimeout(async () => {
      if (previousMode === 'wake-word') {
        await startWakeWord();
        if (returnToCommandMode) {
          try {
            await invoke('stt_enter_command_mode');
          } catch (e) {
            console.error('[STT] Failed to re-enter command mode:', e);
          }
        }
      } else if (previousMode === 'global') {
        await startMic('global');
      } else if (previousMode === 'push-to-talk') {
        await startMic('push-to-talk');
      }
      // If previousMode was 'off', stay off
    }, 300);
  } catch (e) {
    console.error('[STT] Failed to stop dictation:', e);
  }
}
