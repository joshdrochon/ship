/**
 * PF-422 — the webhook signing secret at rest. AES-256-GCM, key from the
 * environment, fail closed.
 *
 * ## Why this file exists at all
 *
 * PRD p.3 says the signing secret is *"hashed"*. PRD p.12's Failure Modes row
 * asks what happens when *"a subscriber's signing secret is rotated
 * mid-flight"*, which presumes the server signs every attempt with the
 * subscription's current secret. HMAC-SHA256 is symmetric, so the server must
 * hold a value it can key an HMAC with. A cryptographic hash is one-way.
 *
 * Those two requirements are not in tension — they are mutually impossible, and
 * the contradiction is the PRD's, not this lane's. It is filed as C3 in
 * `tickets/plugforge/lane-99-unassigned.md`.
 *
 * **The resolution: encrypted at rest, reversible, key never in the database.**
 * Four options were considered and this is the one that ships. The one worth
 * naming as rejected is "store `sha256(secret)` and use that as the HMAC key" —
 * it satisfies the word and is theater, because whatever the server signs with
 * IS the key, so an attacker holding a database dump forges signatures either
 * way. It also silently breaks p.7's printed `verifyWebhook(headers, rawBody,
 * secret)` contract unless the SDK hashes internally, which is a hidden step in
 * a published interface.
 *
 * ## What this buys, stated honestly
 *
 * Confidentiality against a DATABASE DUMP — a leaked backup, a snapshot copied
 * to the wrong bucket, a read replica with the wrong grants. That is the
 * realistic leak and it is a different event, with a very different frequency,
 * from a compromised application host. It buys nothing at all against an
 * attacker who has the host, because the host has the key. Nothing here claims
 * otherwise.
 *
 * ## Fail closed, and where "closed" is
 *
 * `decrypt` throws on a missing key, a wrong key, a truncated payload or a
 * tampered tag. It never returns a best-effort value. The consequence at the
 * one call site that matters is the point of the rule: the signer cannot
 * produce a signature, so the delivery is aborted and **nothing is sent
 * unsigned**. A subscriber receiving an unsigned or wrongly-signed body would
 * have no way to tell it from an attacker.
 *
 * GCM rather than CBC because it is authenticated: a flipped ciphertext bit is a
 * thrown `Unsupported state or unable to authenticate data`, not a corrupted
 * secret that silently produces signatures no subscriber can verify.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The environment variable holding the 32-byte key. Never a database column. */
export const WEBHOOK_SECRET_KEY_ENV = 'WEBHOOK_SECRET_KEY';

/** AES-256. Anything else is a different algorithm, not a shorter key. */
export const WEBHOOK_SECRET_KEY_BYTES = 32;

/**
 * 96 bits, the GCM standard. Not 128: 12 bytes is the only length for which
 * GCM's counter construction is defined directly rather than via GHASH, and it
 * is what every interoperable implementation uses.
 */
const NONCE_BYTES = 12;

/** GCM's authentication tag, appended last. */
const TAG_BYTES = 16;

/**
 * The seam. A repository takes one of these rather than reaching for
 * `process.env` itself, so the composition root stays the only place that
 * resolves a key (PF-427's rule, applied to a credential instead of a class).
 */
export interface SecretCipher {
  /** Raw secret → the value stored in `secret_ciphertext`. */
  encrypt(plaintext: string): string;
  /** `secret_ciphertext` → the raw secret. THROWS rather than returning null. */
  decrypt(ciphertext: string): string;
}

/** Thrown for every failure mode. One type, so a caller cannot handle half of them. */
export class WebhookSecretCryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'WebhookSecretCryptoError';
  }
}

/**
 * AES-256-GCM over `nonce ‖ ciphertext ‖ tag`, base64.
 *
 * The nonce is stored WITH the ciphertext rather than derived, because it must
 * be unique per encryption and a derivation from anything stable (the row id,
 * the version) would repeat it on a re-encrypt. Nonce reuse under GCM is a
 * catastrophic failure — it leaks the XOR of two plaintexts and, worse, the
 * authentication key — so it is generated fresh from `randomBytes` every time.
 */
export class AesGcmSecretCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== WEBHOOK_SECRET_KEY_BYTES) {
      throw new WebhookSecretCryptoError(
        `${WEBHOOK_SECRET_KEY_ENV} must decode to exactly ${WEBHOOK_SECRET_KEY_BYTES} bytes ` +
          `for AES-256-GCM; got ${key.length}. Generate one with: ` +
          `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
  }

  decrypt(stored: string): string {
    let raw: Buffer;
    try {
      raw = Buffer.from(stored, 'base64');
    } catch (cause) {
      throw new WebhookSecretCryptoError('Stored webhook secret is not base64.', { cause });
    }
    if (raw.length <= NONCE_BYTES + TAG_BYTES) {
      throw new WebhookSecretCryptoError(
        `Stored webhook secret is ${raw.length} bytes, which cannot hold a ` +
          `${NONCE_BYTES}-byte nonce, a ${TAG_BYTES}-byte tag and any ciphertext.`,
      );
    }
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch (cause) {
      // A wrong key and a tampered ciphertext are indistinguishable here, and
      // deliberately so — both mean "this value cannot be trusted", and the
      // caller's response to either is the same: abort, send nothing.
      throw new WebhookSecretCryptoError(
        'Webhook signing secret failed to decrypt — the key is wrong or the stored ' +
          'ciphertext was altered. Delivery is aborted; nothing is sent unsigned.',
        { cause },
      );
    }
  }
}

/**
 * Parse the key out of the environment.
 *
 * Base64 first, hex as a fallback, because an operator generating 32 bytes will
 * reach for whichever their tooling prints and neither is wrong. A value that
 * decodes to the wrong length is an error rather than a truncation: a silently
 * padded key encrypts fine and cannot be decrypted by anyone else's copy of the
 * config, which is a failure that shows up long afterwards.
 */
export function parseWebhookSecretKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new WebhookSecretCryptoError(`${WEBHOOK_SECRET_KEY_ENV} is set but empty.`);
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === WEBHOOK_SECRET_KEY_BYTES * 2) {
    return Buffer.from(trimmed, 'hex');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length !== WEBHOOK_SECRET_KEY_BYTES) {
    throw new WebhookSecretCryptoError(
      `${WEBHOOK_SECRET_KEY_ENV} must be ${WEBHOOK_SECRET_KEY_BYTES} bytes as base64 or hex; ` +
        `the supplied value decodes to ${decoded.length} bytes.`,
    );
  }
  return decoded;
}

/**
 * The production cipher — LAZY, and that is the whole design of this function.
 *
 * The key is resolved on FIRST USE, not at construction. `productionDeps()`
 * builds this for every `createApp()` in the repository, including 115 test
 * files that have never heard of webhooks; resolving eagerly would turn a
 * missing `WEBHOOK_SECRET_KEY` into a boot failure for the entire application
 * rather than a failure of the one feature that needs it.
 *
 * Fail-closed is preserved exactly where it matters: the first attempt to
 * encrypt a new subscription's secret, or to decrypt one for signing, throws.
 * A deployment missing the key cannot create a subscription and cannot deliver
 * one — it simply boots, serves every other route, and says why.
 */
export function envSecretCipher(env: NodeJS.ProcessEnv = process.env): SecretCipher {
  let resolved: SecretCipher | undefined;
  const cipher = (): SecretCipher => {
    if (resolved) return resolved;
    const raw = env[WEBHOOK_SECRET_KEY_ENV];
    if (raw === undefined) {
      throw new WebhookSecretCryptoError(
        `${WEBHOOK_SECRET_KEY_ENV} is not set, so webhook signing secrets can be neither ` +
          `stored nor read. This fails closed on purpose: the alternative is a subscription ` +
          `whose secret cannot produce a signature, or worse, a body delivered unsigned. ` +
          `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    resolved = new AesGcmSecretCipher(parseWebhookSecretKey(raw));
    return resolved;
  };
  return {
    encrypt: (plaintext) => cipher().encrypt(plaintext),
    decrypt: (stored) => cipher().decrypt(stored),
  };
}
