/**
 * Whisper.cpp inference via subprocess.
 * Writes utterance to temp WAV file, runs whisper-cli, parses output.
 * Auto-downloads and builds whisper.cpp from source on first use.
 */

import { execFile, execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { downloadFile } from './download';

const WHISPER_THREADS = 4;
const WHISPER_VERSION = 'v1.8.3';
const WHISPER_SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_VERSION}.tar.gz`;

export interface WhisperInstallProgress {
  stage: 'downloading' | 'extracting' | 'building' | 'done' | 'error';
  percent: number;
  message: string;
}

function whisperBinDir(): string {
  return path.join(os.homedir(), '.hivecommand', 'bin');
}

function whisperBinPath(): string {
  return path.join(whisperBinDir(), 'whisper-cli');
}

/** Find the whisper.cpp binary */
export function findWhisperBinary(): string | null {
  // Check common names/locations
  const names = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];
  const extraPaths = [
    whisperBinDir(),
    '/usr/local/bin',
    '/usr/bin',
  ];

  for (const name of names) {
    // Check PATH
    try {
      const result = execSync(`which ${name}`, { encoding: 'utf-8', timeout: 2000 }).trim();
      if (result) return result;
    } catch {}

    // Check extra paths
    for (const dir of extraPaths) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

/**
 * Check if build tools (cmake, make, gcc/g++) are available.
 * Returns missing tool names or empty array if all present.
 */
function checkBuildTools(): string[] {
  const missing: string[] = [];
  for (const tool of ['cmake', 'make', 'g++']) {
    try {
      execSync(`which ${tool}`, { timeout: 2000 });
    } catch {
      missing.push(tool);
    }
  }
  return missing;
}

/**
 * Download whisper.cpp source and build from source.
 * Installs the binary to ~/.hivecommand/bin/whisper-cli.
 */
export async function installWhisperBinary(
  onProgress: (progress: WhisperInstallProgress) => void,
): Promise<string> {
  const destBin = whisperBinPath();

  // Already installed?
  if (fs.existsSync(destBin)) {
    onProgress({ stage: 'done', percent: 100, message: 'Already installed' });
    return destBin;
  }

  // Check build tools
  const missing = checkBuildTools();
  if (missing.length > 0) {
    const msg = `Missing build tools: ${missing.join(', ')}. Install with: sudo apt install ${missing.join(' ')}`;
    onProgress({ stage: 'error', percent: 0, message: msg });
    throw new Error(msg);
  }

  const tmpDir = path.join(os.tmpdir(), `hivecommand-whisper-build-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const tarball = path.join(tmpDir, 'whisper.cpp.tar.gz');

  try {
    // Stage 1: Download source tarball
    onProgress({ stage: 'downloading', percent: 0, message: 'Downloading whisper.cpp source...' });

    await downloadFile(WHISPER_SOURCE_URL, tarball, (p) => {
      onProgress({
        stage: 'downloading',
        percent: Math.round(p.percent * 0.3), // 0-30%
        message: `Downloading: ${(p.bytesDone / 1048576).toFixed(1)} / ${(p.bytesTotal / 1048576).toFixed(1)} MB`,
      });
    });

    // Stage 2: Extract
    onProgress({ stage: 'extracting', percent: 30, message: 'Extracting source...' });
    execSync(`tar xzf "${tarball}" -C "${tmpDir}"`, { timeout: 30000 });

    // Find extracted directory (whisper.cpp-1.8.3 or similar)
    const entries = fs.readdirSync(tmpDir).filter((e) => e.startsWith('whisper'));
    if (entries.length === 0) {
      throw new Error('Failed to find extracted whisper.cpp directory');
    }
    const srcDir = path.join(tmpDir, entries[0]);

    // Stage 3: Build with cmake
    onProgress({ stage: 'building', percent: 35, message: 'Building whisper.cpp (this takes ~30-60s)...' });

    const buildDir = path.join(srcDir, 'build');
    fs.mkdirSync(buildDir, { recursive: true });

    // cmake configure (static link so binary is self-contained)
    await runCommand('cmake', ['..', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF'], { cwd: buildDir });
    onProgress({ stage: 'building', percent: 50, message: 'Compiling...' });

    // cmake build (parallel)
    const cpus = os.cpus().length;
    await runCommand('cmake', ['--build', '.', '--config', 'Release', '-j', String(cpus)], { cwd: buildDir });
    onProgress({ stage: 'building', percent: 90, message: 'Installing binary...' });

    // Find the built binary
    const possibleBins = [
      path.join(buildDir, 'bin', 'whisper-cli'),
      path.join(buildDir, 'bin', 'main'),
      path.join(buildDir, 'whisper-cli'),
      path.join(buildDir, 'main'),
    ];

    let builtBin: string | null = null;
    for (const p of possibleBins) {
      if (fs.existsSync(p)) {
        builtBin = p;
        break;
      }
    }

    if (!builtBin) {
      throw new Error('Build succeeded but could not find whisper-cli binary');
    }

    // Copy to ~/.hivecommand/bin/
    fs.mkdirSync(whisperBinDir(), { recursive: true });
    fs.copyFileSync(builtBin, destBin);
    fs.chmodSync(destBin, 0o755);

    onProgress({ stage: 'done', percent: 100, message: 'whisper.cpp installed successfully' });
    console.error(`[STT] Installed whisper binary: ${destBin}`);

    return destBin;
  } finally {
    // Clean up build directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/** Run a command as a promise */
function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdout?.on('data', () => {}); // drain

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}\n${stderr}`));
      }
    });

    proc.on('error', (e) => reject(e));
  });
}

/**
 * Create a WAV buffer from Float32 PCM samples (16kHz mono 16-bit).
 */
export function createWavBuffer(samples: Float32Array, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // sub-chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Convert float32 to int16
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const val = s < 0 ? s * 32768 : s * 32767;
    buffer.writeInt16LE(Math.round(val), headerSize + i * 2);
  }

  return buffer;
}

/**
 * Run whisper.cpp inference on an audio utterance.
 * Returns the transcribed text.
 */
export function transcribe(
  whisperBin: string,
  modelPath: string,
  samples: Float32Array,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write temp WAV file
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `hivecommand-stt-${Date.now()}.wav`);

    try {
      fs.writeFileSync(tmpFile, createWavBuffer(samples));
    } catch (e) {
      reject(`Failed to write temp WAV: ${e}`);
      return;
    }

    const durationMs = (samples.length / 16000) * 1000;
    console.error(`[STT] Transcribing ${durationMs.toFixed(0)}ms of audio...`);

    const start = Date.now();

    const args = [
      '-m', modelPath,
      '-f', tmpFile,
      '-t', String(WHISPER_THREADS),
      '-l', 'en',
      '--no-timestamps',
      '-np', // no prints
    ];

    execFile(whisperBin, args, { timeout: 60000 }, (err, stdout, stderr) => {
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {}

      if (err) {
        reject(`Whisper inference failed: ${err.message}\n${stderr}`);
        return;
      }

      // Parse output — whisper outputs text lines, strip whitespace
      const text = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('['))
        .join(' ')
        .trim();

      const elapsed = (Date.now() - start) / 1000;
      if (text) {
        console.error(`[STT] Transcription (${elapsed.toFixed(1)}s): "${text}"`);
      } else {
        console.error(`[STT] Empty transcription (noise/silence) (${elapsed.toFixed(1)}s)`);
      }

      resolve(text);
    });
  });
}
