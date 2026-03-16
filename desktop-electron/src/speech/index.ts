/**
 * Speech-to-text state machine and IPC handlers.
 * Port of desktop/src/speech/mod.rs.
 */

import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { VadProcessor, VadEvent } from './vad';
import { AudioCapture, AudioDevice, listInputDevices } from './audio';
import { findWhisperBinary, installWhisperBinary, transcribe } from './whisper';
import { transcribeCloud, CloudProvider } from './cloud-whisper';
import { downloadFile } from './download';
import {
  VoiceCommand,
  CommandMatch,
  BuiltinOverride,
  matchCommand,
  loadCommands,
  getAllCommands,
  getBuiltinDefaults,
} from './commands';
import { classifyCommand, ClassifiedCommand } from './command-classifier';
import { encryptConfig, decryptConfig } from '../crypto-store';

// ---------------------------------------------------------------------------
// Types (mirror Rust types)
// ---------------------------------------------------------------------------

type MicMode = 'off' | 'global' | 'push-to-talk' | 'wake-word';
type SttBackend = 'local' | 'openai' | 'groq';
type WakeWordPhase = 'passive' | 'active';

const MODEL_FILES: Record<string, string> = {
  tiny: 'ggml-tiny.bin',
  small: 'ggml-small.bin',
  medium: 'ggml-medium.bin',
};

function modelDownloadUrl(size: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES[size]}`;
}

function modelsDir(): string {
  return path.join(os.homedir(), '.hivecommand', 'models');
}

function modelPath(size: string): string {
  return path.join(modelsDir(), MODEL_FILES[size]);
}

// ---------------------------------------------------------------------------
// Config persistence (~/.hivecommand/stt-config.json)
// ---------------------------------------------------------------------------

interface SttConfig {
  backend: SttBackend;
  openaiApiKey: string;
  groqApiKey: string;
  modelSize: string;
  wakePhrase: string;
  smartMatching: boolean;
  silenceTimeoutMs: number;
  customCommands?: VoiceCommand[];
  builtinOverrides?: Record<string, BuiltinOverride>;
}

function configPath(): string {
  return path.join(os.homedir(), '.hivecommand', 'stt-config.json');
}

function loadConfig(): Partial<SttConfig> {
  try {
    const data = fs.readFileSync(configPath(), 'utf-8');
    const raw = JSON.parse(data);
    // Decrypt sensitive fields (API keys)
    return decryptConfig(raw);
  } catch {
    return {};
  }
}

function saveConfig(cfg: Partial<SttConfig>) {
  // Load raw (encrypted) config to avoid double-encrypting
  let existing: Record<string, any> = {};
  try {
    const data = fs.readFileSync(configPath(), 'utf-8');
    existing = JSON.parse(data);
  } catch {}
  // Decrypt existing so merge works on plaintext values
  const decrypted = decryptConfig(existing);
  const merged = { ...decrypted, ...cfg };
  // Encrypt sensitive fields before writing
  const encrypted = encryptConfig(merged);
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(encrypted, null, 2));
}

// ---------------------------------------------------------------------------
// Wake phrase matching
// ---------------------------------------------------------------------------

function matchesWakePhrase(transcription: string, wakePhrase: string): boolean {
  const normalized = transcription
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
  const phrase = wakePhrase.toLowerCase().trim();

  // Exact containment
  if (normalized.includes(phrase)) return true;

  // Fuzzy: check if phrase words appear in sequence (allowing extra words)
  // Handles: "hey open flow" vs "hey hivecommand", etc.
  const words = normalized.split(/\s+/);
  const phraseWords = phrase.split(/\s+/);

  let pi = 0;
  for (const w of words) {
    if (pi < phraseWords.length && w === phraseWords[pi]) {
      pi++;
    }
  }
  if (pi === phraseWords.length) return true;

  // Also try joining all words to handle splits/merges
  // e.g., "open flow" should match "hivecommand", "heyhivecommand" should match "hey hivecommand"
  const joinedPhrase = phraseWords.join('');
  const joinedWords = words.join('');
  if (joinedWords.includes(joinedPhrase)) return true;

  // Common tiny model mishearings for "hey hivecommand"
  // The tiny model often hears fast speech as slightly different words
  const aliases: Record<string, string[]> = {
    'hey hivecommand': [
      'hey open flow', 'a hivecommand', 'a open flow',
      'hey hivecommand', 'heyhivecommand', 'hey open flo',
      'hey openflo', 'hey openfloor', 'hey open floor',
      'hey openfl', 'hey open fl', 'hey hivecommand',
      'hey, hivecommand', 'hay hivecommand', 'hey, open flow',
      'hey opin flow', 'hey open fo', 'hey openfo',
    ],
  };

  const phraseAliases = aliases[phrase];
  if (phraseAliases) {
    for (const alias of phraseAliases) {
      if (normalized.includes(alias)) return true;
      // Also check joined version
      if (joinedWords.includes(alias.replace(/\s+/g, ''))) return true;
    }
  }

  // Levenshtein-like: if the joined words are very close to the joined phrase
  // (allows 1-2 character differences for fast/slurred speech)
  if (joinedPhrase.length >= 6) {
    const maxDist = Math.floor(joinedPhrase.length * 0.25); // 25% tolerance
    if (levenshteinDistance(joinedWords, joinedPhrase) <= maxDist) return true;
    // Also try against each sliding window of the input
    for (let i = 0; i <= joinedWords.length - joinedPhrase.length; i++) {
      const window = joinedWords.slice(i, i + joinedPhrase.length);
      if (levenshteinDistance(window, joinedPhrase) <= maxDist) return true;
    }
  }

  return false;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SpeechState {
  mode: MicMode;
  backend: SttBackend;
  openaiApiKey: string;
  groqApiKey: string;
  modelSize: string;
  smartMatching: boolean;
  silenceTimeoutMs: number;
  whisperBin: string | null;
  audioCapture: AudioCapture | null;
  speaking: boolean;
  lastActivity: number; // Date.now()
  selectedDevice: string | undefined;
  vad: VadProcessor | null; // current VAD instance (for muting after beeps)
  // Wake word
  wakePhrase: string;
  wakeWordPhase: WakeWordPhase;
  activeTimeout: ReturnType<typeof setTimeout> | null;
}

const cfg = loadConfig();
const state: SpeechState = {
  mode: 'off',
  backend: (cfg.backend as SttBackend) || 'local',
  openaiApiKey: cfg.openaiApiKey || '',
  groqApiKey: cfg.groqApiKey || '',
  modelSize: cfg.modelSize || 'small',
  smartMatching: cfg.smartMatching !== false, // default true
  silenceTimeoutMs: cfg.silenceTimeoutMs || 800,
  whisperBin: null,
  audioCapture: null,
  vad: null,
  speaking: false,
  lastActivity: Date.now(),
  selectedDevice: undefined,
  wakePhrase: cfg.wakePhrase || 'hey hivecommand',
  wakeWordPhase: 'passive',
  activeTimeout: null,
};

// Load voice commands from config
loadCommands(cfg.customCommands || [], cfg.builtinOverrides || {});

/** Emit an event to all renderer windows */
function emit(channel: string, data?: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data);
  }
}

// ---------------------------------------------------------------------------
// Wake word phase transitions
// ---------------------------------------------------------------------------

const COMMAND_MODE_TIMEOUT = 30_000; // 30s inactivity before returning to passive

function resetActiveTimeout() {
  if (state.activeTimeout) clearTimeout(state.activeTimeout);
  state.activeTimeout = setTimeout(() => {
    console.error('[STT] Command mode timed out after inactivity');
    returnToPassive();
  }, COMMAND_MODE_TIMEOUT);
}

function enterActivePhase() {
  state.wakeWordPhase = 'active';
  emit('stt://wake-word-activated');
  console.error('[STT] Wake word detected — entering active command mode');
  resetActiveTimeout();
}

function returnToPassive() {
  state.wakeWordPhase = 'passive';
  if (state.activeTimeout) {
    clearTimeout(state.activeTimeout);
    state.activeTimeout = null;
  }
  emit('stt://wake-word-passive');
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerSpeechHandlers() {
  // Find whisper binary on startup
  state.whisperBin = findWhisperBinary();
  if (state.whisperBin) {
    console.error(`[STT] Found whisper binary: ${state.whisperBin}`);
  } else {
    console.error('[STT] Whisper binary not found — STT will not work until installed');
  }

  ipcMain.handle('stt_check_model', () => {
    const p = modelPath(state.modelSize);
    const installed = fs.existsSync(p);
    let sizeBytes: number | null = null;
    if (installed) {
      try { sizeBytes = fs.statSync(p).size; } catch {}
    }
    return {
      installed,
      modelSize: state.modelSize,
      path: p,
      sizeBytes,
      active: true,
    };
  });

  ipcMain.handle('stt_list_models', () => {
    const sizes = ['tiny', 'small', 'medium'];
    return sizes.map((size) => {
      const p = modelPath(size);
      const installed = fs.existsSync(p);
      let sizeBytes: number | null = null;
      if (installed) {
        try { sizeBytes = fs.statSync(p).size; } catch {}
      }
      return {
        installed,
        modelSize: size,
        path: p,
        sizeBytes,
        active: size === state.modelSize,
      };
    });
  });

  ipcMain.handle('stt_set_model', (_e, args: { modelSize: string }) => {
    const size = args.modelSize;
    if (!MODEL_FILES[size]) {
      throw new Error(`Unknown model size: ${size}. Use tiny, small, or medium.`);
    }
    const p = modelPath(size);
    if (!fs.existsSync(p)) {
      throw new Error(`Model '${size}' is not installed. Download it first.`);
    }

    if (state.modelSize === size) return;

    console.error(`[STT] Switching model from ${state.modelSize} to ${size}`);
    state.modelSize = size;
    stopCapture();
  });

  ipcMain.handle('stt_download_model', async (_e, args: { modelSize: string }) => {
    const size = args.modelSize;
    if (!MODEL_FILES[size]) {
      throw new Error(`Unknown model size: ${size}. Use tiny, small, or medium.`);
    }

    state.modelSize = size;
    const p = modelPath(size);
    const url = modelDownloadUrl(size);

    await downloadFile(url, p, (progress) => {
      emit('stt://download-progress', progress);
    });
  });

  ipcMain.handle('stt_install_whisper', async () => {
    if (state.whisperBin || findWhisperBinary()) {
      state.whisperBin = state.whisperBin || findWhisperBinary();
      return { installed: true, path: state.whisperBin };
    }

    const binPath = await installWhisperBinary((progress) => {
      emit('stt://whisper-install-progress', progress);
    });

    state.whisperBin = binPath;
    return { installed: true, path: binPath };
  });

  ipcMain.handle('stt_check_whisper', () => {
    const bin = state.whisperBin || findWhisperBinary();
    return { installed: !!bin, path: bin };
  });

  ipcMain.handle('stt_set_backend', (_e, args: { backend: string; openaiApiKey?: string; groqApiKey?: string }) => {
    const backend = args.backend as SttBackend;
    if (backend !== 'local' && backend !== 'openai' && backend !== 'groq') {
      throw new Error(`Unknown backend: ${backend}. Use 'local', 'openai', or 'groq'.`);
    }

    if (backend === 'openai' && !args.openaiApiKey && !state.openaiApiKey) {
      throw new Error('OpenAI API key is required for cloud transcription.');
    }
    if (backend === 'groq' && !args.groqApiKey && !state.groqApiKey) {
      throw new Error('Groq API key is required for Groq transcription.');
    }

    // Stop capture if switching backends while running
    if (state.mode !== 'off' && backend !== state.backend) {
      stopCapture();
    }

    state.backend = backend;
    if (args.openaiApiKey !== undefined) {
      state.openaiApiKey = args.openaiApiKey;
    }
    if (args.groqApiKey !== undefined) {
      state.groqApiKey = args.groqApiKey;
    }

    // Persist
    saveConfig({ backend, openaiApiKey: state.openaiApiKey, groqApiKey: state.groqApiKey });
    console.error(`[STT] Backend set to: ${backend}`);
  });

  ipcMain.handle('stt_get_config', () => ({
    backend: state.backend,
    openaiApiKey: state.openaiApiKey,
    groqApiKey: state.groqApiKey,
    modelSize: state.modelSize,
    wakePhrase: state.wakePhrase,
    smartMatching: state.smartMatching,
    silenceTimeoutMs: state.silenceTimeoutMs,
  }));

  ipcMain.handle('stt_set_silence_timeout', (_e, args: { silenceTimeoutMs: number }) => {
    const ms = Math.max(200, Math.min(5000, args.silenceTimeoutMs));
    state.silenceTimeoutMs = ms;
    saveConfig({ silenceTimeoutMs: ms });
    console.error(`[STT] Silence timeout set to: ${ms}ms`);
  });

  ipcMain.handle('stt_set_smart_matching', (_e, args: { enabled: boolean; openaiApiKey?: string }) => {
    state.smartMatching = args.enabled;
    if (args.openaiApiKey !== undefined) {
      state.openaiApiKey = args.openaiApiKey;
    }
    saveConfig({ smartMatching: args.enabled, openaiApiKey: state.openaiApiKey });
    console.error(`[STT] Smart matching: ${args.enabled ? 'enabled' : 'disabled'}`);
  });

  ipcMain.handle('stt_enter_command_mode', () => {
    if (state.mode === 'wake-word') {
      enterActivePhase();
    }
  });

  ipcMain.handle('stt_set_wake_phrase', (_e, args: { wakePhrase: string }) => {
    const phrase = (args.wakePhrase || '').trim();
    if (!phrase) {
      throw new Error('Wake phrase cannot be empty.');
    }
    state.wakePhrase = phrase;
    saveConfig({ wakePhrase: phrase });
    console.error(`[STT] Wake phrase set to: "${phrase}"`);
  });

  ipcMain.handle('stt_get_voice_commands', () => {
    return {
      commands: getAllCommands(),
      builtinDefaults: getBuiltinDefaults(),
    };
  });

  ipcMain.handle('stt_set_voice_commands', (_e, args: {
    customCommands: VoiceCommand[];
    builtinOverrides: Record<string, BuiltinOverride>;
  }) => {
    loadCommands(args.customCommands, args.builtinOverrides);
    saveConfig({
      customCommands: args.customCommands,
      builtinOverrides: args.builtinOverrides,
    });
    console.error(`[STT] Voice commands updated: ${args.customCommands.length} custom, ${Object.keys(args.builtinOverrides).length} overrides`);
  });

  ipcMain.handle('stt_start', async (_e, args: { mode: string }) => {
    const mode = args.mode as MicMode;
    if (mode !== 'global' && mode !== 'push-to-talk' && mode !== 'wake-word') {
      throw new Error(`Unknown mode: ${mode}. Use 'global', 'push-to-talk', or 'wake-word'.`);
    }

    // Ensure whisper binary exists (needed for all modes)
    if (!state.whisperBin) {
      state.whisperBin = findWhisperBinary();
      if (!state.whisperBin) {
        emit('stt://whisper-install-progress', {
          stage: 'downloading',
          percent: 0,
          message: 'whisper.cpp not found — downloading and building...',
        });

        try {
          state.whisperBin = await installWhisperBinary((progress) => {
            emit('stt://whisper-install-progress', progress);
          });
        } catch (e) {
          throw new Error(
            `Failed to auto-install whisper.cpp: ${e}. ` +
            'You can install manually: sudo apt install cmake g++ && ' +
            'or place whisper-cli in ~/.hivecommand/bin/',
          );
        }
      }
    }

    if (mode === 'wake-word') {
      // Wake word mode: need tiny model for wake detection
      const tinyPath = modelPath('tiny');
      if (!fs.existsSync(tinyPath)) {
        // Auto-download tiny model (75MB, fast)
        console.error('[STT] Tiny model not found — downloading for wake word detection...');
        emit('stt://download-progress', { percent: 0, bytesDone: 0, bytesTotal: 0 });
        await downloadFile(modelDownloadUrl('tiny'), tinyPath, (progress) => {
          emit('stt://download-progress', progress);
        });
        console.error('[STT] Tiny model downloaded');
      }

      // Determine command backend
      const cloudProvider = (state.backend === 'groq' || state.backend === 'openai') ? state.backend as CloudProvider : null;
      const cloudApiKey = cloudProvider === 'groq' ? state.groqApiKey : cloudProvider === 'openai' ? state.openaiApiKey : '';

      if (!state.audioCapture) {
        const vad = new VadProcessor(16000, state.silenceTimeoutMs);
        state.vad = vad;
        const whisperBin = state.whisperBin;
        const tinyModel = tinyPath;

        state.audioCapture = new AudioCapture((samples) => {
          const events = vad.process(samples);
          for (const event of events) {
            handleVadEventWakeWord(event, whisperBin, tinyModel, cloudProvider, cloudApiKey);
          }
        }, state.selectedDevice);
        wireAudioCaptureExit();
      }

      state.wakeWordPhase = 'passive';
    } else if (state.backend === 'openai' || state.backend === 'groq') {
      // Cloud backend: just need API key
      const provider = state.backend as CloudProvider;
      const apiKey = state.backend === 'groq' ? state.groqApiKey : state.openaiApiKey;
      if (!apiKey) {
        throw new Error(`${state.backend === 'groq' ? 'Groq' : 'OpenAI'} API key not set. Configure it in Speech settings.`);
      }

      if (!state.audioCapture) {
        const vad = new VadProcessor(16000, state.silenceTimeoutMs);
        state.vad = vad;

        state.audioCapture = new AudioCapture((samples) => {
          const events = vad.process(samples);
          for (const event of events) {
            handleVadEventCloud(event, provider, apiKey);
          }
        }, state.selectedDevice);
        wireAudioCaptureExit();
      }
    } else {
      // Local backend: need whisper binary + model
      const p = modelPath(state.modelSize);
      if (!fs.existsSync(p)) {
        throw new Error('Model not installed. Call stt_download_model first.');
      }

      if (!state.audioCapture) {
        const vad = new VadProcessor(16000, state.silenceTimeoutMs);
        state.vad = vad;
        const whisperBin = state.whisperBin;
        const mPath = p;

        state.audioCapture = new AudioCapture((samples) => {
          const events = vad.process(samples);
          for (const event of events) {
            handleVadEvent(event, whisperBin, mPath);
          }
        }, state.selectedDevice);
        wireAudioCaptureExit();
      }
    }

    state.mode = mode;
    state.lastActivity = Date.now();
  });

  ipcMain.handle('stt_stop', () => {
    stopCapture();
  });

  ipcMain.handle('stt_unload_model', () => {
    stopCapture();
  });

  ipcMain.handle('stt_status', () => ({
    mode: state.mode,
    backend: state.backend,
    modelLoaded: state.backend === 'openai'
      ? !!state.openaiApiKey
      : state.backend === 'groq'
        ? !!state.groqApiKey
        : (state.whisperBin !== null && fs.existsSync(modelPath(state.modelSize))),
    modelSize: state.modelSize,
    speaking: state.speaking,
    wakeWordPhase: state.mode === 'wake-word' ? state.wakeWordPhase : null,
  }));

  ipcMain.handle('stt_list_devices', () => {
    return listInputDevices();
  });

  ipcMain.handle('stt_set_device', (_e, args: { deviceName: string | null }) => {
    console.error(`[STT] Setting device to: ${args.deviceName}`);
    state.selectedDevice = args.deviceName || undefined;

    // If currently capturing, stop — caller should restart
    if (state.audioCapture) {
      console.error('[STT] Restarting audio capture with new device');
      stopCapture();
    }
  });

  // Inactivity watcher — emit model-unloaded after 5 min idle
  setInterval(() => {
    if (
      state.mode === 'off' &&
      Date.now() - state.lastActivity > 300_000
    ) {
      emit('stt://model-unloaded');
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Wire up audio capture exit handler to reset speaking state if capture dies. */
function wireAudioCaptureExit() {
  if (state.audioCapture) {
    state.audioCapture.onExit = (code) => {
      if (code !== 0 && state.speaking) {
        console.error('[STT] Audio capture died while speaking — resetting speaking state');
        state.speaking = false;
        emit('stt://vad-status', { speaking: false });
      }
    };
  }
}

/** Briefly mute VAD to prevent audio cue beep from being detected as speech. */
function muteVad() {
  if (state.vad) {
    state.vad.mute(500); // 500ms covers beep + PulseAudio buffering + speaker→mic latency
  }
}

function stopCapture() {
  if (state.audioCapture) {
    state.audioCapture.stop();
    state.audioCapture = null;
  }
  state.vad = null;
  if (state.activeTimeout) {
    clearTimeout(state.activeTimeout);
    state.activeTimeout = null;
  }
  state.mode = 'off';
  state.speaking = false;
  state.wakeWordPhase = 'passive';
}

// ---------------------------------------------------------------------------
// Smart command matching (GPT-5 mini with regex fallback)
// ---------------------------------------------------------------------------

interface SmartMatch {
  command: VoiceCommand;
  param: string;
  method: 'gpt5' | 'regex';
}

/** Extract trailing number or number-word from text */
function extractTrailingNumber(text: string): string {
  const numberWords: Record<string, string> = {
    one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
    first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
  };
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const words = normalized.split(/\s+/);
  const last = words[words.length - 1];
  if (/^\d+$/.test(last)) return last;
  if (numberWords[last]) return numberWords[last];
  return '';
}

/** Extract text after the command's trigger phrase */
function extractParamFromText(text: string, cmd: VoiceCommand): string {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  for (const trigger of cmd.triggerPhrases) {
    const normTrigger = trigger.toLowerCase().replace(/[^\w\s]/g, '').trim();
    if (normalized.startsWith(normTrigger)) {
      const remainder = normalized.slice(normTrigger.length).trim();
      if (remainder) return remainder;
    }
  }
  return '';
}

async function matchCommandSmart(text: string): Promise<SmartMatch | null> {
  const commands = getAllCommands().filter((c) => c.enabled);

  // Try GPT-5 mini first if enabled and key available
  if (state.smartMatching && state.openaiApiKey) {
    const commandInfos = commands.map((c) => ({
      id: c.id,
      name: c.name,
      actionKind: c.action.kind,
      actionTarget: 'target' in c.action ? (c.action as { target?: string }).target : undefined,
    }));

    const result = await classifyCommand(text, state.openaiApiKey, commandInfos);
    if (result) {
      const cmd = commands.find((c) => c.id === result.commandId);
      if (cmd) {
        let param = result.param;

        // GPT-5 mini is unreliable at param extraction — extract it ourselves
        if (!param) {
          // For navigate commands, try to extract from the raw text
          if (cmd.action.kind === 'navigate') {
            // First try extracting text after a known trigger phrase
            param = extractParamFromText(text, cmd);
            // If that didn't work, at least grab a trailing number
            if (!param) param = extractTrailingNumber(text);
          }
        }

        // Convert number words in param
        const numberWords: Record<string, string> = {
          one: '1', two: '2', three: '3', four: '4', five: '5',
          six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
        };
        const paramLower = param.toLowerCase().trim();
        if (numberWords[paramLower]) param = numberWords[paramLower];

        return { command: cmd, param, method: 'gpt5' };
      }
    }
  }

  // Regex fallback (when smart matching disabled or GPT-5 mini fails)
  const regexMatch = matchCommand(text);
  if (regexMatch) {
    return { command: regexMatch.command, param: regexMatch.param, method: 'regex' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// VAD event handlers
// ---------------------------------------------------------------------------

function handleVadEvent(event: VadEvent, whisperBin: string, modelPath: string) {
  switch (event.type) {
    case 'utterance':
      muteVad();
      emit('stt://transcribing');
      transcribe(whisperBin, modelPath, event.samples)
        .then(async (text) => {
          if (!text) { muteVad(); return; }
          // In global mode, route through command matching (always-on command mode)
          if (state.mode === 'global' || state.mode === 'push-to-talk') {
            const matched = await matchCommandSmart(text);
            if (matched) {
              const cmd = matched.command;
              // Command matched (silent in production)
              if (cmd.action.kind === 'stop-listening') {
                muteVad();
                emit('stt://voice-command', { commandId: cmd.id, action: cmd.action, param: matched.param, rawText: text });
                stopCapture();
                return;
              }
              if (cmd.action.kind === 'shell') {
                const { command: shellCmd, background } = cmd.action as import('./commands').ShellAction;
                const { exec } = require('child_process');
                if (background) exec(shellCmd, { shell: true });
              }
              muteVad();
              emit('stt://voice-command', { commandId: cmd.id, action: cmd.action, param: matched.param, rawText: text });
            } else {
              muteVad();
              emit('stt://transcription', { text, isFinal: true });
            }
          } else {
            muteVad();
            emit('stt://transcription', { text, isFinal: true });
          }
        })
        .catch((err) => {
          console.error(`[STT] Transcription error: ${err}`);
        });
      break;

    case 'speaking-changed':
      state.speaking = event.speaking;
      emit('stt://vad-status', { speaking: event.speaking });
      break;

    case 'calibrated':
      muteVad();
      emit('stt://ready');
      break;
  }
}

function handleVadEventCloud(event: VadEvent, provider: CloudProvider, apiKey: string) {
  switch (event.type) {
    case 'utterance':
      muteVad();
      emit('stt://transcribing');
      transcribeCloud(provider, apiKey, event.samples)
        .then(async (text) => {
          if (!text) { muteVad(); return; }
          // In global mode, route through command matching (always-on command mode)
          if (state.mode === 'global' || state.mode === 'push-to-talk') {
            const matched = await matchCommandSmart(text);
            if (matched) {
              const cmd = matched.command;
              // Command matched (silent in production)
              if (cmd.action.kind === 'stop-listening') {
                muteVad();
                emit('stt://voice-command', { commandId: cmd.id, action: cmd.action, param: matched.param, rawText: text });
                stopCapture();
                return;
              }
              if (cmd.action.kind === 'shell') {
                const { command: shellCmd, background } = cmd.action as import('./commands').ShellAction;
                const { exec } = require('child_process');
                if (background) exec(shellCmd, { shell: true });
              }
              muteVad();
              emit('stt://voice-command', { commandId: cmd.id, action: cmd.action, param: matched.param, rawText: text });
            } else {
              muteVad();
              emit('stt://transcription', { text, isFinal: true });
            }
          } else {
            muteVad();
            emit('stt://transcription', { text, isFinal: true });
          }
        })
        .catch((err) => {
          console.error(`[STT] ${provider} transcription error: ${err}`);
        });
      break;

    case 'speaking-changed':
      state.speaking = event.speaking;
      emit('stt://vad-status', { speaking: event.speaking });
      break;

    case 'calibrated':
      muteVad();
      emit('stt://ready');
      break;
  }
}

function handleVadEventWakeWord(
  event: VadEvent,
  whisperBin: string,
  tinyModelPath: string,
  cloudProvider: CloudProvider | null,
  cloudApiKey: string,
) {
  switch (event.type) {
    case 'utterance': {
      if (state.wakeWordPhase === 'passive') {
        // Passive: transcribe with tiny model locally — silent, no UI events
        transcribe(whisperBin, tinyModelPath, event.samples)
          .then((text) => {
            if (text && matchesWakePhrase(text, state.wakePhrase)) {
              console.error(`[STT] Wake word detected in: "${text}"`);
              enterActivePhase();
            } else {
              // No wake word match (silent)
            }
          })
          .catch((err) => {
            console.error(`[STT] Wake word transcription error: ${err}`);
          });
      } else {
        // Active: transcribe the command with the best available backend
        muteVad();
      emit('stt://transcribing');

        // Reset active timeout since user is speaking
        resetActiveTimeout();

        // Build prompt hint to bias Whisper toward command vocabulary
        // Use only the first trigger phrase per command to stay under Groq's 896-char limit
        const commandWords = getAllCommands()
          .filter((c) => c.enabled)
          .map((c) => c.triggerPhrases[0])
          .join(', ');
        const promptHint = `Voice commands: ${commandWords}`.slice(0, 890);

        const transcribePromise = cloudProvider && cloudApiKey
          ? transcribeCloud(cloudProvider, cloudApiKey, event.samples, promptHint)
          : transcribe(whisperBin, tinyModelPath, event.samples);

        transcribePromise
          .then(async (text) => {
            if (!text) {
              muteVad();
              resetActiveTimeout();
              return;
            }

            // Match command: smart (GPT-5 mini) or regex fallback
            const matched = await matchCommandSmart(text);

            if (matched) {
              const cmd = matched.command;
              // Command matched (silent in production)

              // Dismiss-commands: return to passive wake word mode
              if (cmd.action.kind === 'dismiss-commands') {
                muteVad();
                emit('stt://voice-command', {
                  commandId: cmd.id,
                  action: cmd.action,
                  param: matched.param,
                  rawText: text,
                });
                returnToPassive();
                return;
              }

              // Stop-listening: stop mic entirely
              if (cmd.action.kind === 'stop-listening') {
                muteVad();
                emit('stt://voice-command', {
                  commandId: cmd.id,
                  action: cmd.action,
                  param: matched.param,
                  rawText: text,
                });
                stopCapture();
                return;
              }

              // Shell commands execute in main process
              if (cmd.action.kind === 'shell') {
                const { command: shellCmd, background } = cmd.action as import('./commands').ShellAction;
                const { exec } = require('child_process');
                if (background) {
                  exec(shellCmd, { shell: true });
                }
              }

              // Emit to renderer
              muteVad();
              emit('stt://voice-command', {
                commandId: cmd.id,
                action: cmd.action,
                param: matched.param,
                rawText: text,
              });

              resetActiveTimeout();
            } else {
              // No command match — emit as regular transcription
              muteVad();
              emit('stt://transcription', { text, isFinal: true });
              resetActiveTimeout();
            }
          })
          .catch((err) => {
            console.error(`[STT] Command transcription error: ${err}`);
            resetActiveTimeout();
          });
      }
      break;
    }

    case 'speaking-changed':
      state.speaking = event.speaking;
      emit('stt://vad-status', { speaking: event.speaking });
      break;

    case 'calibrated':
      muteVad();
      emit('stt://ready');
      break;
  }
}
