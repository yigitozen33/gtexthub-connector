/**
 * The contract between the main process and the window. Types only plus the
 * channel names; no secret ever crosses it (the renderer sends a pasted token
 * once, to `accounts:add`, and never receives one).
 */

export const IPC = {
  getState: 'state:get',
  stateChanged: 'state:changed',
  pair: 'device:pair',
  unpair: 'device:unpair',
  addAccount: 'accounts:add',
  removeAccount: 'accounts:remove',
  setPaused: 'sending:setPaused',
  setAutoStart: 'app:setAutoStart',
} as const;

export type UiConnection = 'unpaired' | 'connecting' | 'online' | 'offline';

export interface UiResult {
  at: string;
  outcome: 'sent' | 'failed';
  reason: string | null;
  discordChannelId: string | null;
}

export interface UiAccount {
  discordUserId: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'active' | 'tokenRejected' | 'refused';
  statusText: string | null;
  addedAt: string;
  lastResults: UiResult[];
}

/**
 * An account the platform expects on this device but whose token this device
 * does not hold (from `GET /deviceexpectedaccounts`). `boundToThisDevice: false`
 * is an account of a previously paired device: a re-pair candidate.
 */
export interface UiExpectedAccount {
  accountId: string;
  discordUserId: string;
  displayName: string;
  avatarUrl: string | null;
  status: string | null;
  disconnectReason: string | null;
  boundToThisDevice: boolean;
}

export interface UiState {
  connection: UiConnection;
  /** Turkish status line: Çalışıyor / Bağlantı yok / Eşleştirilmedi (or Bağlanıyor…). */
  statusLabel: string;
  paused: boolean;
  autoStart: boolean;
  device: { deviceName: string; platform: 'windows' | 'macos'; pairedAt: string } | null;
  defaultDeviceName: string;
  platform: 'windows' | 'macos' | null;
  accounts: UiAccount[];
  /** Accounts waiting for a token on this device ("Bu hesap için token girin"). */
  expectedAccounts: UiExpectedAccount[];
  /** False when the OS keychain / DPAPI is unavailable; nothing secret can be stored then. */
  encryptionAvailable: boolean;
  /** A one-off notice, e.g. after a revocation. */
  notice: string | null;
  version: string;
  environment: string;
}

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string };

/** What the preload exposes on `window.connector`. */
export interface ConnectorBridge {
  getState(): Promise<UiState>;
  pair(code: string, deviceName: string): Promise<ActionResult>;
  unpair(): Promise<ActionResult>;
  /** `expectedDiscordUserId`: the token is entered for that expected account. */
  addAccount(token: string, expectedDiscordUserId?: string | null): Promise<ActionResult>;
  removeAccount(discordUserId: string): Promise<ActionResult>;
  setPaused(paused: boolean): Promise<ActionResult>;
  setAutoStart(enabled: boolean): Promise<ActionResult>;
  onState(listener: (state: UiState) => void): () => void;
}
