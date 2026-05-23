import * as crypto from 'crypto';

// AES-256-GCM:
// nonce(12) || ciphertext(...) || tag(16)
// The plaintext is the JSON envelope below, which embeds a timestamp so that
// the auth service can reject replays without needing per-request server state.

const AES_KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const ENVELOPE_VERSION = 1;

export type UpstreamCredentials = {
  upstreamHost: string;
  username: string;
  // `password` is what the client supplies; it may be a personal access token,
  // an identity token, or an actual password. The wrap module is agnostic.
  password: string;
  // `scope` is the Distribution token-server scope string the client requested.
  // The auth service checks that this scope is consistent with the bytes the
  // upstream returns, so wrapping it inside the AEAD pins the request to a
  // specific scope and prevents a leaked blob from being reused for a
  // different repo.
  scope: string;
};

type Envelope = {
  v: number;
  ts: number; // Unix milliseconds at wrap time
  creds: UpstreamCredentials;
};

export type WrapKey = {
  // `id` is a short, human-readable identifier used in metrics and logs.
  // It is NOT cryptographic material — the actual decrypt-attempt loop tries
  // each `bytes` in order regardless of id.
  id: string;
  bytes: Buffer;
};

export type WrapKeyRing = {
  // First entry is the *current* key used for wrapping.
  // All entries (including current) are tried in order when unwrapping, so
  // rotation works by prepending a new key and keeping the previous one until
  // the rotation window expires.
  keys: WrapKey[];
};

export class WrapError extends Error {
  constructor(message: string, public code: 'invalid_format' | 'unknown_key' | 'expired' | 'bad_envelope') {
    super(message);
    this.name = 'WrapError';
  }
}

/**
 * Parse a comma-separated list of base64-encoded 32-byte keys into a key ring.
 *
 * Format examples:
 *   "AAAA...="                          → single key
 *   "newKeyB64=,oldKeyB64="             → newest first, used for unwrap fallback
 *   "id1:AAAA=,id2:BBBB="               → optional id prefixes for telemetry
 *
 * Whitespace around commas is tolerated. Invalid entries are skipped with a
 * warning so a partial-bad rotation does not break the service entirely.
 */
export function parseWrapKeyRing(raw: string | null | undefined): WrapKeyRing {
  if (raw == null) {
    return { keys: [] };
  }
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const keys: WrapKey[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let id: string;
    let b64: string;
    const colonIdx = entry.indexOf(':');
    if (colonIdx > 0 && colonIdx < 16) {
      id = entry.slice(0, colonIdx);
      b64 = entry.slice(colonIdx + 1);
    } else {
      id = `k${i}`;
      b64 = entry;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    if (bytes.length !== AES_KEY_LEN) {
      continue;
    }
    keys.push({ id, bytes });
  }
  return { keys };
}

/**
 * Wrap upstream credentials with the *current* key (the first entry of the
 * ring). The result is a base64url string suitable for transport in an HTTP
 * header.
 */
export function wrap(keyRing: WrapKeyRing, creds: UpstreamCredentials, now: Date = new Date()): string {
  if (keyRing.keys.length === 0) {
    throw new WrapError('wrap key ring is empty', 'unknown_key');
  }
  const key = keyRing.keys[0];
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    ts: now.getTime(),
    creds,
  };
  const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8');
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key.bytes, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([nonce, ciphertext, tag]);
  return blob.toString('base64url');
}

export type UnwrapResult = {
  creds: UpstreamCredentials;
  wrappedAt: Date;
  ageMs: number;
  keyId: string;
};

/**
 * Unwrap a wrap()'d blob. Tries each key in the ring in order; this is what
 * makes rotation zero-downtime — old blobs encrypted with the previous key
 * still decrypt during the overlap window.
 *
 * Returns the parsed credentials, the wall-clock age of the wrap, and the id
 * of the key that succeeded. Caller is responsible for enforcing a max-age
 * policy (default 10 minutes in F17).
 *
 * Throws WrapError with a specific `code`:
 *   - invalid_format: the blob did not parse as nonce|ciphertext|tag
 *   - unknown_key:    no key in the ring could decrypt it
 *   - bad_envelope:   the decrypted JSON did not have the expected shape
 */
export function unwrap(keyRing: WrapKeyRing, blob: string): UnwrapResult {
  if (keyRing.keys.length === 0) {
    throw new WrapError('wrap key ring is empty', 'unknown_key');
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(blob, 'base64url');
  } catch {
    throw new WrapError('blob is not valid base64url', 'invalid_format');
  }
  if (raw.length < NONCE_LEN + TAG_LEN + 1) {
    throw new WrapError(`blob too short: ${raw.length} bytes`, 'invalid_format');
  }
  const nonce = raw.subarray(0, NONCE_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ciphertext = raw.subarray(NONCE_LEN, raw.length - TAG_LEN);

  for (const key of keyRing.keys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key.bytes, nonce);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const envelope = parseEnvelope(plaintext);
      return {
        creds: envelope.creds,
        wrappedAt: new Date(envelope.ts),
        ageMs: Date.now() - envelope.ts,
        keyId: key.id,
      };
    } catch (err) {
      if (err instanceof WrapError) {
        throw err;
      }
      // Wrong key for this blob; try the next one.
      continue;
    }
  }
  throw new WrapError('no key in ring could decrypt blob', 'unknown_key');
}

function parseEnvelope(plaintext: Buffer): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new WrapError('decrypted envelope is not valid JSON', 'bad_envelope');
  }
  if (!isEnvelope(parsed)) {
    throw new WrapError('decrypted envelope has wrong shape', 'bad_envelope');
  }
  if (parsed.v !== ENVELOPE_VERSION) {
    throw new WrapError(`unsupported envelope version: ${parsed.v}`, 'bad_envelope');
  }
  return parsed;
}

function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== 'object' || v == null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.v !== 'number') return false;
  if (typeof obj.ts !== 'number') return false;
  const creds = obj.creds;
  if (typeof creds !== 'object' || creds == null) return false;
  const c = creds as Record<string, unknown>;
  return (
    typeof c.upstreamHost === 'string' &&
    typeof c.username === 'string' &&
    typeof c.password === 'string' &&
    typeof c.scope === 'string'
  );
}

/**
 * Stable, short identifier for proof-cache keying. SHA-256 over
 * host||username||password — never include the wrapped blob itself (the nonce
 * makes each blob unique even for identical creds, defeating the cache).
 */
export function credIdentity(creds: UpstreamCredentials): string {
  return crypto
    .createHash('sha256')
    .update(creds.upstreamHost)
    .update('\x00')
    .update(creds.username)
    .update('\x00')
    .update(creds.password)
    .digest('hex');
}
