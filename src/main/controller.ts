/**
 * Glue between storage, the core device loop and the UI. No Electron import:
 * the Electron entry wires safeStorage, the tray and the window around it.
 */
import { EventEmitter } from 'node:events';
import { AccountService } from '../core/accounts';
import { type AgentStatus, DeviceAgent } from '../core/agent';
import {
  ConnectorApi,
  ConnectorApiError,
  DeviceRevokedError,
  type DevicePlatform,
  type ExpectedAccount,
  PairingCodeInvalidError,
  PairingThrottledError,
  hasErrorCode,
  isConnectivityError,
} from '../core/connectorApi';
import { DiscordClient } from '../core/discord';
import { type HttpClient, fetchHttpClient } from '../core/http';
import { RequestJournal } from '../core/journal';
import type { Logger, Redactor } from '../core/logger';
import type { ActionResult, UiConnection, UiExpectedAccount, UiState } from '../shared/ipc';
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
/** `disconnectReason` of an account the user removed in this program (POST /connectoraccountremovals). */
export const CONNECTOR_REMOVED_REASON = 'connector-removed';

/**
 * Splits the expected accounts this device holds no token for: those the user
 * removed here (`connector-removed`, still bound to this device) go to a quiet
 * list; everything else (token-missing, path-changed, device-revoked, other
 * reasons, or `boundToThisDevice: false`) is a prompt for a token.
 */
export function splitExpectedAccounts(
  expected: ExpectedAccount[],
  heldDiscordUserIds: Iterable<string>,
): { prompt: UiExpectedAccount[]; removed: UiExpectedAccount[] } {
  const held = new Set(heldDiscordUserIds);
  const prompt: UiExpectedAccount[] = [];
  const removed: UiExpectedAccount[] = [];
  for (const e of expected) {
    if (held.has(e.discordUserId)) continue;
    const row: UiExpectedAccount = {
      accountId: e.accountId,
      discordUserId: e.discordUserId,
      displayName: e.displayName,
      avatarUrl: e.avatarUrl,
      status: e.status,
      disconnectReason: e.disconnectReason,
      boundToThisDevice: e.boundToThisDevice,
    };
    if (e.boundToThisDevice && e.disconnectReason === CONNECTOR_REMOVED_REASON) removed.push(row);
    else prompt.push(row);
  }
  return { prompt, removed };
}

const PAIRING_THROTTLED_MESSAGE = 'Çok fazla deneme yapıldı, birkaç dakika sonra tekrar deneyin.';

const UNPAIR_UNREACHABLE_NOTICE =
  'Eşleştirme bu bilgisayarda kaldırıldı ve yerel veriler silindi, ancak GTextHub sunucusuna ulaşılamadı. ' +
  'Cihaz panelde hâlâ görünüyorsa web panelindeki Cihazlar sayfasından da kaldırın.';
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
  /** The last `GET /deviceexpectedaccounts` answer (memory only; never secret). */
  private expected: ExpectedAccount[] = [];

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
    const expected = this.isPaired
      ? splitExpectedAccounts(this.expected, this.stateFile.state.accounts.map((a) => a.discordUserId))
      : { prompt: [], removed: [] };
    return {
      connection,
      statusLabel: STATUS_LABELS[connection],
      paused: this.paused,
      autoStart: this.o.getAutoStart(),
      device: this.isPaired ? this.stateFile.state.device : null,
      defaultDeviceName: this.o.defaultDeviceName,
      platform: this.o.platform,
      expectedAccounts: expected.prompt,
      removedAccounts: expected.removed,
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

  /** Re-fetches the expected accounts (window opened, account added or removed). */
  async refreshExpectedAccounts(): Promise<void> {
    await this.agent?.refreshExpectedAccounts();
  }

  /** The window was opened or brought to front. */
  windowShown(): void {
    void this.refreshExpectedAccounts();
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
          // Re-validation may re-bind accounts; fetch the expected list again after it.
          if (first) void this.revalidateAccounts().then(() => this.refreshExpectedAccounts());
        },
        onRequestHandled: () => this.changed(),
        onExpectedAccounts: (accounts) => {
          if (this.agent !== agent) return;
          this.expected = accounts;
          this.changed();
        },
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
    this.expected = [];
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
      if (err instanceof PairingThrottledError) {
        this.o.logger.warn('pairing throttled by the platform');
        return { ok: false, message: PAIRING_THROTTLED_MESSAGE };
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

  /**
   * "Eşleştirmeyi kaldır": revokes this device on the platform
   * (`PATCH /connectorselfrevoke`), then wipes local state. A 401 there means
   * already revoked: success. Any other failure (network, 5xx, another 4xx) still
   * wipes, and the window tells the user the device may need removing on the
   * web panel.
   */
  async unpair(): Promise<ActionResult> {
    if (!this.isPaired) {
      await this.wipeLocal();
      this.changed();
      return { ok: true, message: 'Eşleştirme kaldırıldı ve yerel veriler silindi.' };
    }
    // Stop the loop first: a 401 it sees after the revoke must not race this wipe.
    this.agent?.stop();
    let platformDone = true;
    try {
      await this.api.revokeSelf();
      this.o.logger.info('device revoked on the platform by the user');
    } catch (err) {
      if (err instanceof DeviceRevokedError || (err instanceof ConnectorApiError && err.status === 401)) {
        this.o.logger.info('device already revoked on the platform');
      } else {
        platformDone = false;
        this.o.logger.warn('device revoke not delivered; wiping locally anyway', {
          status: (err as ConnectorApiError)?.status,
          errorCode: (err as ConnectorApiError)?.errorCode,
          error: err instanceof ConnectorApiError ? undefined : (err as Error)?.message,
        });
      }
    }
    this.o.logger.info('unpaired by the user; wiping local state');
    await this.wipeLocal();
    this.notice = platformDone ? null : UNPAIR_UNREACHABLE_NOTICE;
    this.changed();
    return platformDone
      ? { ok: true, message: 'Eşleştirme kaldırıldı: cihaz GTextHub panelinden de kaldırıldı ve yerel veriler silindi.' }
      : { ok: true, message: UNPAIR_UNREACHABLE_NOTICE };
  }

  async addAccount(token: string, expectedDiscordUserId: string | null = null): Promise<ActionResult> {
    if (!this.isPaired) return { ok: false, message: 'Önce bu bilgisayarı eşleştirin.' };
    if (!this.vault.available) return { ok: false, message: ENCRYPTION_MESSAGE };
    try {
      const r = await this.accounts.add(token, expectedDiscordUserId);
      if (!r.ok) {
        if (r.revoked) await this.handleRevoked();
        return { ok: false, message: r.message };
      }
      void this.refreshExpectedAccounts();
      const verb = r.registration.result === 'recovered' ? 'yeniden bağlandı' : 'eklendi';
      return { ok: true, message: `${r.account.displayName} ${verb}.` };
    } catch (err) {
      if (err instanceof EncryptionUnavailableError) return { ok: false, message: ENCRYPTION_MESSAGE };
      this.o.logger.error('adding an account failed', { error: String(err) });
      return { ok: false, message: 'Hesap eklenemedi.' };
    }
  }

  /**
   * Reports the removal to the platform (`POST /connectoraccountremovals`), then
   * deletes the token. The local removal never waits on the platform.
   */
  async removeAccount(discordUserId: string): Promise<ActionResult> {
    if (!this.isPaired) {
      await this.store.remove(discordUserId);
      return { ok: true, message: 'Hesap ve tokeni bu bilgisayardan silindi.' };
    }
    const outcome = await this.accounts.remove(discordUserId);
    this.o.logger.info('account removed; token deleted', { discordUserId, platform: outcome.platform });
    if (outcome.platform === 'revoked') {
      await this.handleRevoked();
      return { ok: true, message: REVOKED_NOTICE };
    }
    void this.refreshExpectedAccounts();
    if (outcome.platform === 'unreachable' || outcome.platform === 'refused') {
      return {
        ok: true,
        message:
          'Hesap ve tokeni bu bilgisayardan silindi, ancak GTextHub sunucusuna bildirilemedi. ' +
          'Hesap panelde hâlâ bu cihaza bağlı görünebilir.',
      };
    }
    return { ok: true, message: 'Hesap ve tokeni bu bilgisayardan silindi; GTextHub paneline de bildirildi.' };
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
