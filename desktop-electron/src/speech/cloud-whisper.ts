/**
 * Cloud Whisper API transcription (OpenAI + Groq).
 * Both use the same OpenAI-compatible endpoint format.
 */

import * as https from 'https';
import { createWavBuffer } from './whisper';

export type CloudProvider = 'openai' | 'groq';

interface ProviderConfig {
  hostname: string;
  path: string;
  model: string;
  label: string;
}

const PROVIDERS: Record<CloudProvider, ProviderConfig> = {
  openai: {
    hostname: 'api.openai.com',
    path: '/v1/audio/transcriptions',
    model: 'whisper-1',
    label: 'OpenAI',
  },
  groq: {
    hostname: 'api.groq.com',
    path: '/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
    label: 'Groq',
  },
};

/**
 * Transcribe audio using a cloud Whisper API (OpenAI or Groq).
 * Returns the transcribed text.
 */
export function transcribeCloud(
  provider: CloudProvider,
  apiKey: string,
  samples: Float32Array,
  promptHint?: string,
): Promise<string> {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  return new Promise((resolve, reject) => {
    const wavBuffer = createWavBuffer(samples);
    const durationMs = (samples.length / 16000) * 1000;
    console.error(`[STT] ${cfg.label}: Transcribing ${durationMs.toFixed(0)}ms of audio (${cfg.model})...`);

    const start = Date.now();

    // Build multipart/form-data body
    const boundary = `----HiveCommandBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // file field
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
    ));
    parts.push(wavBuffer);
    parts.push(Buffer.from('\r\n'));

    // model field
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${cfg.model}\r\n`,
    ));

    // language field (speeds up processing)
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `en\r\n`,
    ));

    // prompt field (biases Whisper toward expected vocabulary)
    if (promptHint) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `${promptHint}\r\n`,
      ));
    }

    // response_format field
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `text\r\n`,
    ));

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const req = https.request(
      {
        hostname: cfg.hostname,
        path: cfg.path,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          const elapsed = (Date.now() - start) / 1000;

          if (!res.statusCode || res.statusCode >= 400) {
            console.error(`[STT] ${cfg.label} error (${res.statusCode}): ${data}`);
            reject(new Error(`${cfg.label} API error ${res.statusCode}: ${data}`));
            return;
          }

          // response_format=text returns plain text
          const text = data.trim();
          if (text) {
            console.error(`[STT] ${cfg.label} transcription (${elapsed.toFixed(1)}s): "${text}"`);
          } else {
            console.error(`[STT] ${cfg.label}: empty transcription (${elapsed.toFixed(1)}s)`);
          }

          resolve(text);
        });
      },
    );

    req.on('error', (e) => reject(new Error(`${cfg.label} request failed: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${cfg.label} request timed out`));
    });

    req.write(body);
    req.end();
  });
}
