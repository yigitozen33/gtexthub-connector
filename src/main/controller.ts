/**
 * Glue between storage, the core device loop and the UI. No Electron import:
 * the Electron entry wires safeStorage, the tray and the window around it.
 */
import { EventEmitter } from 'node:events';
import { AccountService } from '../core/accounts';
import { type AgentStatus, DeviceAgent } from '../core/agent';
import {
  ConnectorApi,
  DeviceRevokedError,
  type DevicePlatform,
  PairingCodeInvalidError,
  hasErrorCode,
  isConnectivityError,
} from '../core/connectorApi';
import { DiscordClient } from '../core/discord';
import { type HttpClient, fetchHttpClient } from '../core/http';
import { RequestJournal } from '../core/journal';
import type { Logger, Redactor } from '../core/logger';
import type { ActionResult, UiConnection, UiState } from '../shared/ipc';
import {
  EncryptionUnavailableError,
  type Encryptor,
  FileAccountStore,
  SecretVault,
  StateFile,
  journalPersistence,
  removeJournal,
} from './storage';

export interface ControllerOptions {
  dataDir: string;
  encryptor: Encryptor;
  logger: Logger;
  redactor: Redactor;
  apiBase: string;
  platform: DevicePlatform | null;
  defaultDeviceName: string;
  version: string;
  environment: string;
  getAutoStart: () => boolean;
  applyAutoStart: (enabled: boolean) => void;
  http?: HttpClient;
}

const STATUS_LABELS: Record<UiConnection, string> = {
  unpaired: 'Eşleştirilmedi',
  connecting: 'Bağlanıyor…',
  online: 'Çalışıyor',
  offline: 'Bağlantı yok',
};

const REVOKED_NOTICE =
  'Bu cihazın eşleştirmesi kaldırılmış. Yerel veriler silindi; devam etmek için web panelinden yeni bir eşleştirme kodu alın.';
const ENCRYPTION_MESSAGE =
  'Bu bilgisayarda güvenli anahtar deposu (Anahtar Zinciri / DPAPI) kullanılamıyor; gizli bilgiler kaydedilemez.';

export class ConnectorController extends EventEmitter {
  private readonly vault: SecretVault;
  private readonly stateFile: StateFile;
  private readonly store: FileAccountStore;
  private readonly api: ConnectorApi;
  private readonly discord: DiscordClient;
  private readonly accounts: AccountService;
  private agent: DeviceAgent | null = null;
  private agentStatus: AgentStatus = 'stopped';
  private notice: string | null = null;

  constructor(private readonly o: ControllerOptions) {
    super();
    const http = o.http ?? fetchHttpClient;
    this.vault = new SecretVault(o.dataDir, o.encryptor, o.redactor);
    this.stateFile = new StateFile(o.dataDir);
    this.store = new FileAccountStore(this.stateFile, this.vault, () => this.changed());
    this.api = new ConnectorApi(o.apiBase, http, () => this.vault.device);
    this.discord = new DiscordClient(http);
    this.accounts = new AccountService(this.api, this.discord, this.store, o.logger);
  }

  async init(): Promise<void> {
    await this.vault.load();
    this.stateFile.load();
    if (this.stateFile.state.device && !this.vault.device) {
      // Metadata without a credential (keychain reset, copied profile): start over.
      this.o.logger.warn('paired state without a credential; resetting');
      this.stateFile.reset();
    }
    this.o.logger.info('started', {
      version: this.o.version,
      environment: this.o.environment,
      apiBase: this.o.apiBase,
      paired: this.isPaired,
      accounts: this.stateFile.state.accounts.length,
      encryptionAvailable: this.vault.available,
    });
    if (this.isPaired) this.startAgent();
  }

  get isPaired(): boolean {
    return !!this.vault.device && !!this.stateFile.state.device;
  }

  get paused(): boolean {
    return this.stateFile.state.paused;
  }

  private changed(): void {
    this.emit('change', this.state());
  }

  private connection(): UiConnection {
    if (!this.isPaired) return 'unpaired';
    if (this.agentStatus === 'online') return 'online';
    if (this.agentStatus === 'offline') return 'offline';
    return 'connecting';
  }

  state(): UiState {
    const connection = this.connection();
    return {
      connection,
      statusLabel: STATUS_LABELS[connection],
      paused: this.paused,
      autoStart: this.o.getAutoStart(),
      device: this.isPaired ? this.stateFile.state.device : null,
      defaultDeviceName: this.o.defaultDeviceName,
      platform: this.o.platform,
      accounts: this.stateFile.state.accounts.map((a) => ({
        discordUserId: a.discordUserId,
        displayName: a.displayName,
        avatarUrl: a.avatarUrl,
        status: a.status,
        statusText: a.statusText,
        addedAt: a.addedAt,
        lastResults: (a.lastResults ?? []).slice(0, 5).map((r) => ({
          at: r.at,
          outcome: r.outcome,
          reason: r.reason,
          discordChannelId: r.discordChannelId,
        })),
      })),
      encryptionAvailable: this.vault.available,
      notice: this.notice,
      version: this.o.version,
      environment: this.o.environment,
    };
  }

  private startAgent(): void {
    this.agent?.stop();
    const journal = new RequestJournal(journalPersistence(this.o.dataDir));
    const agent = new DeviceAgent({
      api: this.api,
      discord: this.discord,
      store: this.store,
      journal,
      logger: this.o.logger,
      isPaused: () => this.paused,
      hooks: {
        onStatus: (s) => {
          if (this.agent !== agent) return;
          this.agentStatus = s;
          this.changed();
        },
        onRevoked: () => {
          if (this.agent === agent) void this.handleRevoked();
        },
        onOnline: (first) => {
          if (first) void this.revalidateAccounts();
        },
        onRequestHandled: () => this.changed(),
      },
    });
    this.agent = agent;
    agent.start();
  }

  private async revalidateAccounts(): Promise<void> {
    try {
      await this.accounts.revalidateAll();
    } catch (err) {
      if (err instanceof DeviceRevokedError) await this.handleRevoked();
      else this.o.logger.warn('account re-validation failed', { error: String(err) });
    }
  }

  private async wipeLocal(): Promise<void> {
    this.agent?.stop();
    this.agent = null;
    this.agentStatus = 'stopped';
    await this.vault.wipe();
    this.stateFile.reset();
    removeJournal(this.o.dataDir);
    this.o.redactor.clear();
  }

  private async handleRevoked(): Promise<void> {
    this.o.logger.warn('device revoked; wiping local credentials and tokens');
    await this.wipeLocal();
    this.notice = REVOKED_NOTICE;
    this.changed();
  }

  async pair(code: string, deviceName: string): Promise<ActionResult> {
    if (this.isPaired) return { ok: false, message: 'Bu bilgisayar zaten eşleştirilmiş.' };
    if (!this.o.platform) return { ok: false, message: 'Bu işletim sistemi desteklenmiyor (yalnızca Windows ve macOS).' };
    if (!this.vault.available) return { ok: false, message: ENCRYPTION_MESSAGE };
    const cleanCode = code.trim();
    const name = (deviceName.trim() || this.o.defaultDeviceName).slice(0, 64);
    if (!/^[0-9A-Za-z][0-9A-Za-z\s-]{3,20}$/.test(cleanCode)) {
      return { ok: false, message: 'Kodu web panelinde gösterildiği gibi girin (ör. ABCD-EFGH).' };
    }
    try {
      const creds = await this.api.pair(cleanCode, name, this.o.platform);
      await this.vault.setDevice(creds);
      this.stateFile.state = {
        device: { deviceName: name, platform: this.o.platform, pairedAt: new Date().toISOString() },
        paused: false,
        accounts: [],
      };
      this.stateFile.save();
      this.notice = null;
      this.o.logger.info('paired', { deviceId: creds.deviceId, deviceName: name, platform: this.o.platform });
      this.startAgent();
      this.changed();
      return { ok: true, message: 'Cihaz eşleştirildi.' };
    } catch (err) {
      if (err instanceof PairingCodeInvalidError) {
        return { ok: false, message: 'Kod geçersiz, kullanılmış ya da süresi dolmuş. Web panelinden yeni bir kod alın.' };
      }
      if (hasErrorCode(err, 'errMsg_DeviceLimitReached')) {
        return { ok: false, message: 'En fazla 3 cihaz eşleştirilebilir. Önce web panelinden bir cihazı kaldırın.' };
      }
      if (hasErrorCode(err, 'errMsg_DeviceNameInvalid')) return { ok: false, message: 'Cihaz adı geçersiz (en fazla 64 karakter).' };
      if (err instanceof EncryptionUnavailableError) return { ok: false, message: ENCRYPTION_MESSAGE };
      if (isConnectivityError(err)) return { ok: false, message: 'GTextHub sunucusuna ulaşılamadı. Bağlantınızı kontrol edin.' };
      this.o.logger.error('pairing failed', { error: String(err) });
      return { ok: false, message: 'Eşleştirme başarısız oldu. Lütfen tekrar deneyin.' };
    }
  }

  async unpair(): Promise<ActionResult> {
    this.o.logger.info('unpaired by the user; wiping local state');
    await this.wipeLocal();
    this.notice = null;
    this.changed();
    return { ok: true, message: 'Eşleştirme kaldırıldı ve yerel veriler silindi.' };
  }

  async addAccount(token: string): Promise<ActionResult> {
    if (!this.isPaired) return { ok: false, message: 'Önce bu bilgisayarı eşleştirin.' };
    if (!this.vault.available) return { ok: false, message: ENCRYPTION_MESSAGE };
    try {
      const r = await this.accounts.add(token);
      if (!r.ok) {
        if (r.revoked) await this.handleRevoked();
        return { ok: false, message: r.message };
      }
      const verb = r.registration.result === 'recovered' ? 'yeniden bağlandı' : 'eklendi';
      return { ok: true, message: `${r.account.displayName} ${verb}.` };
    } catch (err) {
      if (err instanceof EncryptionUnavailableError) return { ok: false, message: ENCRYPTION_MESSAGE };
      this.o.logger.error('adding an account failed', { error: String(err) });
      return { ok: false, message: 'Hesap eklenemedi.' };
    }
  }

  async removeAccount(discordUserId: string): Promise<ActionResult> {
    await this.store.remove(discordUserId);
    this.o.logger.info('account removed; token deleted', { discordUserId });
    return {
      ok: true,
      message: 'Hesap ve tokeni bu bilgisayardan silindi. Hesabı web panelinden de silmeyi unutmayın.',
    };
  }

  async setPaused(paused: boolean): Promise<ActionResult> {
    this.stateFile.state.paused = paused;
    this.stateFile.save();
    this.o.logger.info(paused ? 'sending paused' : 'sending resumed');
    this.changed();
    return { ok: true };
  }

  async setAutoStart(enabled: boolean): Promise<ActionResult> {
    this.o.applyAutoStart(enabled);
    this.changed();
    return { ok: true };
  }

  shutdown(): void {
    this.agent?.stop();
  }
}
