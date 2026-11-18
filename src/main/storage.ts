/**
 * Local persistence in userData:
 *   secrets.bin  - the device credential and every Discord token, ONLY as a
 *                  safeStorage (Keychain / DPAPI) encrypted blob;
 *   state.json   - non-secret state: device name, pause flag, account
 *                  metadata and the last send results (no message text);
 *   journal.json - the request journal (ids, outcomes; no text, no secret).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type AccountMeta,
  type AccountStore,
  MAX_RESULTS_PER_ACCOUNT,
  type SendResultEntry,
} from '../core/accounts';
import type { DeviceCredentials, DevicePlatform } from '../core/connectorApi';
import type { JournalEntry, JournalPersistence } from '../core/journal';
import type { Redactor } from '../core/logger';

/** The OS-backed encryption (Electron safeStorage: Keychain on macOS, DPAPI on Windows). */
export interface Encryptor {
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('OS encryption (Keychain / DPAPI) is unavailable');
    this.name = 'EncryptionUnavailableError';
  }
}

function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface Secrets {
  device: DeviceCredentials | null;
  tokens: Record<string, string>;
}

export class SecretVault {
  private readonly file: string;
  private secrets: Secrets = { device: null, tokens: {} };
  private _available = false;
  /** Writes are serialized so the file always holds the latest snapshot. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    dir: string,
    private readonly enc: Encryptor,
    private readonly redactor: Redactor,
  ) {
    this.file = path.join(dir, 'secrets.bin');
  }

  get available(): boolean {
    return this._available;
  }

  /** Loads the blob; an unreadable blob (other user, other machine) is treated as empty. */
  async load(): Promise<void> {
    this.secrets = { device: null, tokens: {} };
    try {
      this._available = await this.enc.isAvailable();
    } catch {
      this._available = false;
    }
    if (!fs.existsSync(this.file) || !this._available) return;
    let reEncrypt = false;
    try {
      const { result, shouldReEncrypt } = await this.enc.decrypt(fs.readFileSync(this.file));
      reEncrypt = shouldReEncrypt;
      const parsed = JSON.parse(result) as Partial<Secrets>;
      this.secrets = {
        device:
          parsed.device && typeof parsed.device.deviceId === 'string' && typeof parsed.device.deviceCredential === 'string'
            ? parsed.device
            : null,
        tokens: parsed.tokens && typeof parsed.tokens === 'object' ? { ...parsed.tokens } : {},
      };
    } catch {
      this.secrets = { device: null, tokens: {} };
    }
    this.redactor.add(this.secrets.device?.deviceCredential);
    for (const t of Object.values(this.secrets.tokens)) this.redactor.add(t);
    if (reEncrypt) await this.persist();
  }

  private persist(): Promise<void> {
    if (!this._available) return Promise.reject(new EncryptionUnavailableError());
    const snapshot = JSON.stringify(this.secrets);
    const next = this.writes.then(async () => {
      writeAtomic(this.file, await this.enc.encrypt(snapshot));
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  get device(): DeviceCredentials | null {
    return this.secrets.device;
  }

  async setDevice(device: DeviceCredentials): Promise<void> {
    this.secrets.device = { ...device };
    this.redactor.add(device.deviceCredential);
    await this.persist();
  }

  getToken(discordUserId: string): string | null {
    return this.secrets.tokens[discordUserId] ?? null;
  }

  async setToken(discordUserId: string, token: string): Promise<void> {
    this.secrets.tokens[discordUserId] = token;
    this.redactor.add(token);
    await this.persist();
  }

  async deleteToken(discordUserId: string): Promise<void> {
    if (!(discordUserId in this.secrets.tokens)) return;
    delete this.secrets.tokens[discordUserId];
    await this.persist();
  }

  /** Removes every secret from memory and disk. */
  async wipe(): Promise<void> {
    this.secrets = { device: null, tokens: {} };
    await this.writes;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // nothing to remove
    }
  }
}

export interface PersistedState {
  device: { deviceName: string; platform: DevicePlatform; pairedAt: string } | null;
  paused: boolean;
  accounts: AccountMeta[];
}

const EMPTY_STATE: PersistedState = { device: null, paused: false, accounts: [] };

export class StateFile {
  private readonly file: string;
  state: PersistedState = { ...EMPTY_STATE, accounts: [] };

  constructor(dir: string) {
    this.file = path.join(dir, 'state.json');
  }

  load(): void {
    const s = readJson<Partial<PersistedState>>(this.file);
    this.state = {
      device: s?.device ?? null,
      paused: s?.paused === true,
      accounts: Array.isArray(s?.accounts) ? s!.accounts : [],
    };
  }

  save(): void {
    writeAtomic(this.file, JSON.stringify(this.state, null, 2));
  }

  reset(): void {
    this.state = { ...EMPTY_STATE, accounts: [] };
    this.save();
  }
}

/** AccountStore of core, backed by state.json (metadata) and the vault (tokens). */
export class FileAccountStore implements AccountStore {
  constructor(
    private readonly stateFile: StateFile,
    private readonly vault: SecretVault,
    private readonly onChange: () => void,
  ) {}

  list(): AccountMeta[] {
    return this.stateFile.state.accounts.map((a) => ({ ...a }));
  }

  async getToken(discordUserId: string): Promise<string | null> {
    return this.vault.getToken(discordUserId);
  }

  async save(meta: AccountMeta, token: string): Promise<void> {
    await this.vault.setToken(meta.discordUserId, token);
    const others = this.stateFile.state.accounts.filter((a) => a.discordUserId !== meta.discordUserId);
    this.stateFile.state.accounts = [...others, { ...meta }];
    this.stateFile.save();
    this.onChange();
  }

  async update(discordUserId: string, patch: Partial<Omit<AccountMeta, 'discordUserId'>>): Promise<void> {
    const acc = this.stateFile.state.accounts.find((a) => a.discordUserId === discordUserId);
    if (!acc) return;
    Object.assign(acc, patch);
    this.stateFile.save();
    this.onChange();
  }

  async recordResult(discordUserId: string, entry: SendResultEntry): Promise<void> {
    const acc = this.stateFile.state.accounts.find((a) => a.discordUserId === discordUserId);
    if (!acc) return;
    acc.lastResults = [entry, ...(acc.lastResults ?? [])].slice(0, MAX_RESULTS_PER_ACCOUNT);
    this.stateFile.save();
    this.onChange();
  }

  async remove(discordUserId: string): Promise<void> {
    await this.vault.deleteToken(discordUserId);
    this.stateFile.state.accounts = this.stateFile.state.accounts.filter((a) => a.discordUserId !== discordUserId);
    this.stateFile.save();
    this.onChange();
  }
}

export function journalPersistence(dir: string): JournalPersistence {
  const file = path.join(dir, 'journal.json');
  return {
    read: () => readJson<JournalEntry[]>(file),
    write: (entries) => {
      try {
        writeAtomic(file, JSON.stringify(entries));
      } catch {
        // a lost journal write only weakens restart de-duplication
      }
    },
  };
}

export function removeJournal(dir: string): void {
  try {
    fs.rmSync(path.join(dir, 'journal.json'), { force: true });
  } catch {
    // nothing to remove
  }
}
