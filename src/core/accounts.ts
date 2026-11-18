/**
 * Discord accounts held by this connector: the storage contract core needs, and
 * the add / re-validate flows (validate the token locally against Discord, then
 * report the account - never the token - to the platform).
 */
import {
  type AccountRegistration,
  type AccountRemoval,
  type ConnectorApi,
  ConnectorApiError,
  DeviceRevokedError,
  hasErrorCode,
  isConnectivityError,
} from './connectorApi';
import type { DiscordClient, DiscordUser } from './discord';
import { type Logger, nullLogger } from './logger';

export type AccountStatus = 'active' | 'tokenRejected' | 'refused';

export interface SendResultEntry {
  at: string;
  kind: 'handOff';
  outcome: 'sent' | 'failed';
  reason: string | null;
  discordChannelId: string | null;
}

export interface AccountMeta {
  discordUserId: string;
  displayName: string;
  avatarUrl: string | null;
  status: AccountStatus;
  statusText: string | null;
  platformAccountId: string | null;
  addedAt: string;
  lastResults: SendResultEntry[];
}

/** Storage of accounts and their tokens. The Electron side encrypts tokens with safeStorage. */
export interface AccountStore {
  list(): AccountMeta[];
  getToken(discordUserId: string): Promise<string | null>;
  /** Saves (or replaces) the account and its token. */
  save(meta: AccountMeta, token: string): Promise<void>;
  update(discordUserId: string, patch: Partial<Omit<AccountMeta, 'discordUserId'>>): Promise<void>;
  recordResult(discordUserId: string, entry: SendResultEntry): Promise<void>;
  /** Deletes the account and its token. */
  remove(discordUserId: string): Promise<void>;
}

export const MAX_RESULTS_PER_ACCOUNT = 20;

/** Turkish message for a refusal of `reportConnectorAccount` (relayed from discord.registerConnectorAccount). */
export function registrationRefusalMessage(err: unknown): string {
  if (hasErrorCode(err, 'errMsg_NoActiveLicense')) return 'Aktif bir lisansınız yok. Hesap eklemek için lisans gerekir.';
  if (hasErrorCode(err, 'errMsg_AccountLimitReached')) return 'Lisansınızın hesap sınırına ulaşıldı.';
  if (hasErrorCode(err, 'errMsg_AccountBoundElsewhere'))
    return 'Bu Discord hesabı panelde başka bir gönderim yoluna veya başka bir cihaza bağlı.';
  if (hasErrorCode(err, 'errMsg_TokenRejected')) return 'Discord bu tokeni reddetti.';
  if (hasErrorCode(err, 'errMsg_AccountReportInvalid')) return 'Hesap bilgileri geçersiz.';
  if (isConnectivityError(err)) return 'GTextHub sunucusuna ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.';
  if (err instanceof ConnectorApiError) return `Hesap kaydedilemedi (HTTP ${err.status}).`;
  return 'Hesap kaydedilemedi.';
}

/** Trims a pasted token: whitespace and surrounding quotes. */
export function normalizeToken(raw: string): string {
  return raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
}

export type AddAccountResult =
  | { ok: true; account: AccountMeta; registration: AccountRegistration }
  | { ok: false; message: string; revoked?: boolean };

/**
 * How the platform took a removal: `released` / `notBound` (both success),
 * `unreachable` (network or 5xx: removed locally only), `refused` (another 4xx,
 * removed locally only), `revoked` (the device itself is gone).
 */
export type RemovalOutcome =
  | { platform: 'released' | 'notBound'; accountId: string | null }
  | { platform: 'unreachable' | 'refused' | 'revoked' };

export class AccountService {
  constructor(
    private readonly api: ConnectorApi,
    private readonly discord: DiscordClient,
    private readonly store: AccountStore,
    private readonly logger: Logger = nullLogger,
  ) {}

  /**
   * Validates the token with Discord, reports the account, and only then stores
   * the token. `expectedDiscordUserId` (the token was entered for an account the
   * platform expects here) refuses a token of another account before anything
   * is reported.
   */
  async add(rawToken: string, expectedDiscordUserId?: string | null): Promise<AddAccountResult> {
    const token = normalizeToken(rawToken);
    if (token.length < 20 || /\s/.test(token)) return { ok: false, message: 'Bu bir Discord tokeni gibi görünmüyor.' };

    const check = await this.discord.validateToken(token);
    if (!check.ok) {
      const r = check.result;
      if (r.failure === 'tokenRejected') return { ok: false, message: 'Discord bu tokeni reddetti. Tokeni kontrol edin.' };
      return { ok: false, message: `Token doğrulanamadı: ${r.detailedReason ?? r.reason ?? 'bilinmeyen hata'}` };
    }
    const user = check.user;
    if (expectedDiscordUserId && user.discordUserId !== expectedDiscordUserId) {
      return {
        ok: false,
        message: `Bu token seçilen hesaba değil, ${user.displayName} hesabına ait. Seçilen hesabın tokenini girin.`,
      };
    }

    let registration: AccountRegistration;
    try {
      registration = await this.api.reportAccount({
        discordUserId: user.discordUserId,
        discordUsername: user.displayName,
        avatarUrl: user.avatarUrl,
        tokenValid: true,
      });
    } catch (err) {
      if (err instanceof DeviceRevokedError) return { ok: false, message: 'Bu cihazın eşleştirmesi kaldırılmış.', revoked: true };
      this.logger.warn('account report refused', { status: (err as ConnectorApiError).status, errorCode: (err as ConnectorApiError).errorCode });
      return { ok: false, message: registrationRefusalMessage(err) };
    }

    const existing = this.store.list().find((a) => a.discordUserId === user.discordUserId);
    const meta: AccountMeta = {
      discordUserId: user.discordUserId,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      status: 'active',
      statusText: null,
      platformAccountId: registration.accountId ?? existing?.platformAccountId ?? null,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      lastResults: existing?.lastResults ?? [],
    };
    await this.store.save(meta, token);
    this.logger.info('account added', { discordUserId: user.discordUserId, result: registration.result });
    return { ok: true, account: meta, registration };
  }

  /**
   * Removes an account: first tells the platform (`POST /connectoraccountremovals`),
   * then deletes the local token. The local removal never waits on the platform:
   * a network failure or a refusal is logged and the token is deleted anyway.
   * On revocation the token is deleted too; the caller wipes the rest.
   */
  async remove(discordUserId: string): Promise<RemovalOutcome> {
    let outcome: RemovalOutcome;
    try {
      const r: AccountRemoval = await this.api.removeAccount(discordUserId);
      outcome = { platform: r.result ?? 'notBound', accountId: r.accountId };
      this.logger.info('account removal reported', { discordUserId, result: r.result, accountId: r.accountId });
    } catch (err) {
      if (err instanceof DeviceRevokedError) {
        outcome = { platform: 'revoked' };
      } else if (isConnectivityError(err)) {
        outcome = { platform: 'unreachable' };
        this.logger.warn('account removal not reported (platform unreachable); removing locally', {
          discordUserId,
          status: (err as ConnectorApiError).status,
          error: err instanceof ConnectorApiError ? undefined : (err as Error).message,
        });
      } else {
        outcome = { platform: 'refused' };
        this.logger.warn('account removal refused by the platform; removing locally', {
          discordUserId,
          status: (err as ConnectorApiError)?.status,
          errorCode: (err as ConnectorApiError)?.errorCode,
        });
      }
    }
    await this.store.remove(discordUserId);
    return outcome;
  }

  /**
   * Re-checks every held token with Discord and reports the outcome (UC19:
   * "on a locally validated or rejected token: reportConnectorAccount"). This
   * recovers an account the user moved to this device on the web panel, and
   * reports a token Discord now rejects. Connectivity failures are skipped.
   * Throws DeviceRevokedError.
   */
  async revalidateAll(): Promise<void> {
    for (const acc of this.store.list()) {
      const token = await this.store.getToken(acc.discordUserId);
      if (!token) continue;
      const check = await this.discord.validateToken(token);
      let user: DiscordUser | null = null;
      let tokenValid: boolean;
      if (check.ok) {
        user = check.user;
        tokenValid = true;
      } else if (check.result.failure === 'tokenRejected') {
        tokenValid = false;
      } else {
        continue; // Discord unreachable or rate limited: nothing to report.
      }
      try {
        const reg = await this.api.reportAccount({
          discordUserId: acc.discordUserId,
          discordUsername: user?.displayName ?? acc.displayName,
          avatarUrl: user?.avatarUrl ?? acc.avatarUrl,
          tokenValid,
        });
        await this.store.update(acc.discordUserId, {
          status: tokenValid ? 'active' : 'tokenRejected',
          statusText: tokenValid ? null : 'Discord tokeni reddetti',
          displayName: user?.displayName ?? acc.displayName,
          avatarUrl: user?.avatarUrl ?? acc.avatarUrl,
          platformAccountId: reg.accountId ?? acc.platformAccountId,
        });
      } catch (err) {
        if (err instanceof DeviceRevokedError) throw err;
        if (isConnectivityError(err)) continue;
        await this.store.update(acc.discordUserId, {
          status: tokenValid ? 'refused' : 'tokenRejected',
          statusText: tokenValid ? registrationRefusalMessage(err) : 'Discord tokeni reddetti',
        });
      }
    }
  }
}
