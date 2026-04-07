/**
 * flush-gate.ts — Buffer WebSocket messages during burst, flush on calm.
 *
 * When output arrives faster than the client can consume it,
 * the flush gate batches messages and sends them in chunks.
 * This prevents the WebSocket from being overwhelmed during
 * high-output operations (like large test suites or builds).
 */

export interface FlushGateOptions {
  /** Maximum messages to buffer before force-flushing */
  maxBufferSize: number;
  /** Milliseconds of calm before flushing buffered messages */
  calmThresholdMs: number;
  /** Maximum milliseconds to hold messages before force-flushing */
  maxHoldMs: number;
}

const DEFAULT_OPTIONS: FlushGateOptions = {
  maxBufferSize: 100,
  calmThresholdMs: 50,
  maxHoldMs: 200,
};

export class FlushGate {
  private buffer: string[] = [];
  private flushCallback: (messages: string[]) => void;
  private options: FlushGateOptions;
  private calmTimer: ReturnType<typeof setTimeout> | null = null;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageTime: number = 0;
  private _flushedCount: number = 0;
  private _bufferedCount: number = 0;

  constructor(
    flushCallback: (messages: string[]) => void,
    options?: Partial<FlushGateOptions>,
  ) {
    this.flushCallback = flushCallback;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Enqueue a message. May trigger immediate or deferred flush.
   */
  push(message: string): void {
    this.buffer.push(message);
    this._bufferedCount++;
    this.lastMessageTime = Date.now();

    // Force flush if buffer is full
    if (this.buffer.length >= this.options.maxBufferSize) {
      this.flush();
      return;
    }

    // Reset calm timer
    if (this.calmTimer) clearTimeout(this.calmTimer);
    this.calmTimer = setTimeout(() => this.flush(), this.options.calmThresholdMs);

    // Set force timer if not already set
    if (!this.forceTimer) {
      this.forceTimer = setTimeout(() => this.flush(), this.options.maxHoldMs);
    }
  }

  /**
   * Flush all buffered messages immediately.
   */
  flush(): void {
    if (this.calmTimer) {
      clearTimeout(this.calmTimer);
      this.calmTimer = null;
    }
    if (this.forceTimer) {
      clearTimeout(this.forceTimer);
      this.forceTimer = null;
    }

    if (this.buffer.length > 0) {
      const messages = [...this.buffer];
      this.buffer = [];
      this._flushedCount += messages.length;
      this.flushCallback(messages);
    }
  }

  /**
   * Get stats about the flush gate.
   */
  get stats(): { buffered: number; flushed: number; pending: number } {
    return {
      buffered: this._bufferedCount,
      flushed: this._flushedCount,
      pending: this.buffer.length,
    };
  }

  /**
   * Destroy the gate, flushing remaining messages.
   */
  destroy(): void {
    this.flush();
  }
}
