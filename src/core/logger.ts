/**
 * Logger contract for core plus the redaction used by every log sink.
 * Core code never passes a secret to the logger; redaction is the second line
 * of defence (a Discord message or a stack could still echo one).
 */

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Header and field names whose values are never written anywhere. */
const SECRET_KEYS = /^(authorization|x-device-credential|devicecredential|token|discordtoken|credential|password)$/i;

/** Discord user-token shapes (three base64url segments, or the legacy mfa. form). */
const DISCORD_TOKEN_RE = /\b(?:mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,})\b/g;

export class Redactor {
  private secrets = new Set<string>();

  /** Registers a concrete secret value (device credential, a token) for scrubbing. */
  add(secret: string | null | undefined): void {
    if (typeof secret === 'string' && secret.length >= 6) this.secrets.add(secret);
  }

  remove(secret: string | null | undefined): void {
    if (typeof secret === 'string') this.secrets.delete(secret);
  }

  clear(): void {
    this.secrets.clear();
  }

  text(input: string): string {
    let out = input;
    for (const s of this.secrets) out = out.split(s).join('***');
    return out.replace(DISCORD_TOKEN_RE, '***');
  }

  value(input: unknown, depth = 0): unknown {
    if (typeof input === 'string') return this.text(input);
    if (input === null || typeof input !== 'object' || depth > 5) return input;
    if (input instanceof Error) return this.text(`${input.name}: ${input.message}`);
    if (Array.isArray(input)) return input.map((v) => this.value(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '***' : this.value(v, depth + 1);
    }
    return out;
  }
}
