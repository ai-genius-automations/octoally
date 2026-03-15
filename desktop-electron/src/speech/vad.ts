/**
 * Energy-based Voice Activity Detection.
 * Direct TypeScript port of desktop/src/speech/vad.rs
 */

const FRAME_MS = 30;
const MIN_SPEECH_MS = 300;
const MAX_SPEECH_MS = 30_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 800;
const CALIBRATION_FRAMES = 66; // ~2 seconds

export type VadEvent =
  | { type: 'utterance'; samples: Float32Array }
  | { type: 'speaking-changed'; speaking: boolean }
  | { type: 'calibrated' };

export class VadProcessor {
  private frameSize: number;
  private silenceTimeoutMs: number;
  private energyThreshold = 0.01;
  private calibrationEnergies: number[] = [];
  private calibrated = false;
  private isSpeaking = false;
  private speechFrames = 0;
  private silenceFrames = 0;
  private buffer: number[] = [];
  private pending: number[] = [];
  private muteUntil = 0; // timestamp — ignore audio until this time (prevents beep pickup)

  constructor(sampleRate: number, silenceTimeoutMs?: number) {
    this.frameSize = Math.floor((sampleRate * FRAME_MS) / 1000);
    this.silenceTimeoutMs = silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
  }

  /** Update the silence timeout dynamically (in milliseconds). */
  setSilenceTimeout(ms: number) {
    this.silenceTimeoutMs = ms;
  }

  /** Suppress VAD for the given duration (ms). Used to ignore audio cue beeps. */
  mute(durationMs: number) {
    this.muteUntil = Date.now() + durationMs;
    this.resetState();
  }

  process(samples: Float32Array | number[]): VadEvent[] {
    // Append to pending
    for (let i = 0; i < samples.length; i++) {
      this.pending.push(samples[i]);
    }

    const events: VadEvent[] = [];

    while (this.pending.length >= this.frameSize) {
      const frame = this.pending.splice(0, this.frameSize);
      this.processFrame(frame, events);
    }

    return events;
  }

  private processFrame(frame: number[], events: VadEvent[]) {
    // Skip processing while muted (audio cue playing — prevents beep pickup)
    if (Date.now() < this.muteUntil) return;

    const energy = rmsEnergy(frame);

    // Calibration phase
    if (!this.calibrated) {
      this.calibrationEnergies.push(energy);
      if (this.calibrationEnergies.length >= CALIBRATION_FRAMES) {
        const sorted = [...this.calibrationEnergies].sort((a, b) => a - b);
        const lowerHalf = sorted.slice(0, Math.floor(sorted.length / 2));
        const ambient = lowerHalf.reduce((a, b) => a + b, 0) / lowerHalf.length;
        this.energyThreshold = Math.min(Math.max(ambient * 3.0, 0.01), 0.03);
        this.calibrated = true;
        console.error(
          `[STT] VAD calibrated: ambient=${ambient.toFixed(6)}, threshold=${this.energyThreshold.toFixed(6)}`,
        );
        events.push({ type: 'calibrated' });
      }
      return;
    }

    const isSpeech = energy > this.energyThreshold;

    if (isSpeech && !this.isSpeaking) {
      console.error(`[STT] VAD: speech started (energy=${energy.toFixed(4)})`);
    }

    if (isSpeech) {
      this.silenceFrames = 0;
      this.speechFrames++;

      if (!this.isSpeaking) {
        this.isSpeaking = true;
        events.push({ type: 'speaking-changed', speaking: true });
        this.buffer.length = 0;
      }

      for (let i = 0; i < frame.length; i++) this.buffer.push(frame[i]);

      const speechMs = this.speechFrames * FRAME_MS;
      if (speechMs >= MAX_SPEECH_MS) {
        const utterance = this.finishUtterance();
        if (utterance) events.push({ type: 'utterance', samples: utterance });
        events.push({ type: 'speaking-changed', speaking: false });
      }
    } else if (this.isSpeaking) {
      this.silenceFrames++;
      for (let i = 0; i < frame.length; i++) this.buffer.push(frame[i]);

      const silenceMs = this.silenceFrames * FRAME_MS;
      if (silenceMs >= this.silenceTimeoutMs) {
        const speechMs = this.speechFrames * FRAME_MS;
        if (speechMs >= MIN_SPEECH_MS) {
          const utterance = this.finishUtterance();
          if (utterance) events.push({ type: 'utterance', samples: utterance });
        } else {
          this.resetState();
        }
        events.push({ type: 'speaking-changed', speaking: false });
      }
    }
  }

  private finishUtterance(): Float32Array | null {
    const durationMs = this.speechFrames * FRAME_MS;
    const utterance = new Float32Array(this.buffer);
    this.resetState();

    if (utterance.length === 0) return null;
    console.error(`[STT] VAD: speech ended (${durationMs}ms)`);
    return utterance;
  }

  private resetState() {
    this.isSpeaking = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.buffer.length = 0;
  }
}

function rmsEnergy(frame: number[]): number {
  if (frame.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
  return Math.sqrt(sumSq / frame.length);
}
