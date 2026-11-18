/** Environment-level settings that do not depend on Electron. */
import os from 'node:os';
import type { DevicePlatform } from './connectorApi';

export const API_BASES = {
  preview: 'https://xkjhy36p.mindbricks.dev/connector-api',
  production: 'https://xkjhy36p.mindbricks.app/connector-api',
} as const;

export type ApiEnvironment = keyof typeof API_BASES;

/**
 * The API base: the build-time default, unless an override is given (dev only:
 * the `GTH_API_BASE` environment variable or `apiBase` in dev-config.json).
 * Only https URLs are accepted, plus http on localhost for a local farm.
 */
export function resolveApiBase(buildDefault: string, override?: string | null): string {
  const candidate = (override ?? '').trim();
  if (candidate) {
    try {
      const u = new URL(candidate);
      const localHttp = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
      if (u.protocol === 'https:' || localHttp) return candidate.replace(/\/+$/, '');
    } catch {
      // fall through to the default
    }
  }
  return buildDefault.replace(/\/+$/, '');
}

/** The platform enum of ConnectorDevice; only Windows and macOS are supported. */
export function detectPlatform(nodePlatform: NodeJS.Platform = process.platform): DevicePlatform | null {
  if (nodePlatform === 'darwin') return 'macos';
  if (nodePlatform === 'win32') return 'windows';
  return null;
}

/** Default device name: the computer's hostname without a `.local` suffix, max 64 characters. */
export function defaultDeviceName(hostname: string = os.hostname()): string {
  const name = hostname.replace(/\.local$/i, '').trim();
  return (name || 'Bilgisayar').slice(0, 64);
}
