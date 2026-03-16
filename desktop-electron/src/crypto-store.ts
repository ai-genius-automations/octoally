/**
 * Encrypt-at-rest for sensitive config values (API keys).
 *
 * Uses AES-256-GCM with a key derived from a random salt (stored in
 * ~/.hivecommand/.keyfile) + machine-specific context via PBKDF2.
 *
 * Encrypted values are stored as "enc:<base64>" strings.
 * Plaintext values (legacy) are detected and re-encrypted on next save.
 *
 * Works on Linux and macOS — uses only Node built-ins (crypto, os, fs).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const ENC_PREFIX = 'enc:';

// ---------------------------------------------------------------------------
// Machine context — deterministic per user+machine, not secret by itself
// ---------------------------------------------------------------------------

function machineContext(): string {
  const hostname = os.hostname();
  const userInfo = os.userInfo();
  // uid is numeric on Linux/macOS, username as fallback
  const userId = userInfo.uid !== -1 ? String(userInfo.uid) : userInfo.username;
  return `hivecommand:${hostname}:${userId}`;
}

// ---------------------------------------------------------------------------
// Salt management — random 32-byte salt stored in ~/.hivecommand/.keyfile
// ---------------------------------------------------------------------------

function keyfilePath(): string {
  return path.join(os.homedir(), '.hivecommand', '.keyfile');
}

function getSalt(): Buffer {
  const kfPath = keyfilePath();
  try {
    const buf = fs.readFileSync(kfPath);
    if (buf.length >= 32) return buf.subarray(0, 32);
  } catch {
    // File doesn't exist — create it
  }

  const salt = crypto.randomBytes(32);
  const dir = path.dirname(kfPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(kfPath, salt, { mode: 0o600 });

  // Also tighten permissions on the directory
  try { fs.chmodSync(dir, 0o700); } catch {}

  return salt;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

function deriveKey(): Buffer {
  const salt = getSalt();
  const context = machineContext();
  return crypto.pbkdf2Sync(context, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

let _cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (!_cachedKey) _cachedKey = deriveKey();
  return _cachedKey;
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;

  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack as: iv(12) + tag(16) + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);
  return ENC_PREFIX + packed.toString('base64');
}

export function decrypt(stored: string): string {
  if (!stored) return stored;

  // Plaintext (legacy) — not encrypted, return as-is
  if (!stored.startsWith(ENC_PREFIX)) return stored;

  try {
    const packed = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    if (packed.length < IV_LENGTH + TAG_LENGTH) return '';

    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);

    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    // Decryption failed — key changed or data corrupt. Return empty.
    return '';
  }
}

// ---------------------------------------------------------------------------
// Config helpers — encrypt/decrypt specific fields in a config object
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set(['openaiApiKey', 'groqApiKey']);

/** Encrypt sensitive fields in-place (returns new object). */
export function encryptConfig<T extends Record<string, any>>(cfg: T): T {
  const out = { ...cfg };
  for (const key of SENSITIVE_KEYS) {
    if (key in out && typeof out[key] === 'string' && out[key] && !out[key].startsWith(ENC_PREFIX)) {
      (out as any)[key] = encrypt(out[key]);
    }
  }
  return out;
}

/** Decrypt sensitive fields in-place (returns new object). */
export function decryptConfig<T extends Record<string, any>>(cfg: T): T {
  const out = { ...cfg };
  for (const key of SENSITIVE_KEYS) {
    if (key in out && typeof out[key] === 'string' && out[key].startsWith(ENC_PREFIX)) {
      (out as any)[key] = decrypt(out[key]);
    }
  }
  return out;
}
