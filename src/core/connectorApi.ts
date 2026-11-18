/**
 * Client of the GTextHub `connector` service's device doors.
 *
 * Contract: docs/service-spec-connector.md ("Device authentication", the device
 * APIs) and the generated managers under services/connector/src/api-layer.
 * Every device call carries `x-device-id` and `x-device-credential`; the pairing
 * call carries neither (the code is the credential).
 */
import { type HttpClient, NetworkError } from './http';

export type DevicePlatform = 'windows' | 'macos';

export interface DeviceCredentials {
  deviceId: string;
  deviceCredential: string;
}

/** One row of `GET /devicerequests/pending` (selected columns of DeviceRequest). */
export interface PendingRequest {
  id: string;
  kind: 'handOff' | 'guildChannels';
  sendRecordId?: string | null;
  accountId?: string | null;
  payload?: {
    discordUserId?: string;
    discordChannelId?: string;
    text?: string;
  } | null;
  createdAt?: string;
}

export interface GuildChannelsAnswer {
  guildId: string;
  guildName: string;
  channels: Array<{ channelId: string; discordChannelId: string; channelName: string }>;
}

/** One row of `GET /deviceexpectedaccounts`: a `connector`-path account the platform expects on a device. */
export interface ExpectedAccount {
  accountId: string;
  discordUserId: string;
  displayName: string;
  avatarUrl: string | null;
  status: string | null;
  disconnectReason: string | null;
  /** false: bound to a revoked device or to none - a re-pair candidate. */
  boundToThisDevice: boolean;
}

/** Why a guild-channel request is answered without a list. */
export type GuildChannelsUnavailableReason = 'tokenMissing' | 'discordUnavailable';

export interface AccountRemoval {
  /** `released` (unbound from this device) or `notBound` (nothing to release); both are success. */
  result: 'released' | 'notBound' | null;
  accountId: string | null;
}

export interface AccountRegistration {
  /** `registered` (new), `recovered` (known, token valid) or `disconnected` (reported invalid). */
  result: string | null;
  accountId: string | null;
}

/** The platform answered with an HTTP error (RFC 9457 problem+json). */
export class ConnectorApiError extends Error {
  readonly status: number;
  /** e.g. `errMsg_DeviceCredentialInvalid`; null when the body carries none. */
  readonly errorCode: string | null;
  readonly detail: string | null;
  constructor(status: number, errorCode: string | null, detail: string | null) {
    super(`connector API ${status}${errorCode ? ` ${errorCode}` : ''}`);
    this.name = 'ConnectorApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.detail = detail;
  }
}

/** 401 errMsg_DeviceCredentialInvalid: the device was revoked or deleted. */
export class DeviceRevokedError extends ConnectorApiError {
  constructor(detail: string | null) {
    super(401, 'errMsg_DeviceCredentialInvalid', detail);
    this.name = 'DeviceRevokedError';
  }
}

/** Unknown, used or expired pairing code (404, or 200 `{}` under onNotFound: complete). */
export class PairingCodeInvalidError extends Error {
  constructor() {
    super('pairing code invalid');
    this.name = 'PairingCodeInvalidError';
  }
}

/** Transport failure or a 5xx: the platform is unreachable right now. */
export function isConnectivityError(err: unknown): boolean {
  return err instanceof NetworkError || (err instanceof ConnectorApiError && err.status >= 500);
}

const DEVICE_CREDENTIAL_INVALID = 'errMsg_DeviceCredentialInvalid';
const API_TIMEOUT_MS = 20_000;

function problemOf(data: unknown): { errorCode: string | null; detail: string | null } {
  const d = (data ?? {}) as Record<string, unknown>;
  const errorCode = typeof d.errorCode === 'string' ? d.errorCode : null;
  const detail = typeof d.detail === 'string' ? d.detail : typeof d.message === 'string' ? d.message : null;
  return { errorCode, detail };
}

/** Whether an error (or its detail) carries the given `errMsg_*` code. */
export function hasErrorCode(err: unknown, code: string): boolean {
  if (!(err instanceof ConnectorApiError)) return false;
  return err.errorCode === code || (err.detail ?? '').includes(code);
}

export function normalizeApiBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

export class ConnectorApi {
  private readonly base: string;

  constructor(
    base: string,
    private readonly http: HttpClient,
    private readonly getCredentials: () => DeviceCredentials | null,
  ) {
    this.base = normalizeApiBase(base);
  }

  private deviceHeaders(): Record<string, string> {
    const c = this.getCredentials();
    if (!c) throw new DeviceRevokedError('not paired');
    return { 'x-device-id': c.deviceId, 'x-device-credential': c.deviceCredential, Accept: 'application/json' };
  }

  private async call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const res = await this.http({ method, url: this.base + path, headers, body, timeoutMs: API_TIMEOUT_MS });
    if (res.status >= 200 && res.status < 300) return res.data;
    const { errorCode, detail } = problemOf(res.data);
    if (res.status === 401 && (errorCode === DEVICE_CREDENTIAL_INVALID || (detail ?? '').includes(DEVICE_CREDENTIAL_INVALID))) {
      throw new DeviceRevokedError(detail);
    }
    throw new ConnectorApiError(res.status, errorCode, detail);
  }

  /** `POST /devicepairings` - redeems a pairing code; the credential is returned once. */
  async pair(code: string, deviceName: string, platform: DevicePlatform): Promise<DeviceCredentials> {
    let data: unknown;
    try {
      data = await this.call(
        'POST',
        '/devicepairings',
        { code: code.trim(), deviceName: deviceName.trim().slice(0, 64), platform },
        { Accept: 'application/json' },
      );
    } catch (err) {
      if (err instanceof ConnectorApiError && (err.status === 404 || hasErrorCode(err, 'errMsg_PairingCodeInvalid'))) {
        throw new PairingCodeInvalidError();
      }
      throw err;
    }
    const d = (data ?? {}) as Record<string, unknown>;
    const deviceId = typeof d.deviceId === 'string' ? d.deviceId : null;
    const deviceCredential = typeof d.deviceCredential === 'string' ? d.deviceCredential : null;
    // onNotFound: complete answers 200 `{}` for an unknown, used or expired code.
    if (!deviceId || !deviceCredential) throw new PairingCodeInvalidError();
    return { deviceId, deviceCredential };
  }

  /** `PATCH /connectorheartbeat`. */
  async heartbeat(): Promise<void> {
    await this.call('PATCH', '/connectorheartbeat', undefined, this.deviceHeaders());
  }

  /** `GET /devicerequests/pending` - pending requests younger than 5 minutes, oldest first. */
  async listPending(): Promise<PendingRequest[]> {
    const data = (await this.call('GET', '/devicerequests/pending', undefined, this.deviceHeaders())) as
      | { data?: unknown }
      | null;
    const rows = Array.isArray(data?.data) ? (data!.data as unknown[]) : Array.isArray(data) ? (data as unknown[]) : [];
    return rows.filter(
      (r): r is PendingRequest =>
        !!r && typeof (r as PendingRequest).id === 'string' &&
        ((r as PendingRequest).kind === 'handOff' || (r as PendingRequest).kind === 'guildChannels'),
    );
  }

  /** `POST /connectoraccountreports` - never carries the token. */
  async reportAccount(report: {
    discordUserId: string;
    discordUsername: string;
    avatarUrl?: string | null;
    tokenValid: boolean;
  }): Promise<AccountRegistration> {
    const body: Record<string, unknown> = {
      discordUserId: report.discordUserId,
      discordUsername: report.discordUsername.slice(0, 100),
      tokenValid: report.tokenValid,
    };
    if (report.avatarUrl) body.avatarUrl = report.avatarUrl;
    const data = (await this.call('POST', '/connectoraccountreports', body, this.deviceHeaders())) as
      | { registration?: Record<string, unknown> | null }
      | null;
    const reg = (data?.registration ?? {}) as Record<string, unknown>;
    return {
      result: typeof reg.result === 'string' ? reg.result : null,
      accountId: typeof reg.accountId === 'string' ? reg.accountId : typeof reg.id === 'string' ? reg.id : null,
    };
  }

  /** `PATCH /devicerequests/:deviceRequestId/sendresult`. */
  async reportSendResult(
    deviceRequestId: string,
    result: { outcome: 'sent' | 'failed'; reason?: string | null; tokenRejected: boolean; tokenMissing?: boolean },
  ): Promise<void> {
    const body: Record<string, unknown> = { outcome: result.outcome, tokenRejected: result.tokenRejected };
    if (result.outcome === 'failed') body.reason = (result.reason || 'Gönderilemedi').slice(0, 500);
    // `tokenMissing: true` requires `outcome = failed` (else 400); sent only when set.
    if (result.outcome === 'failed' && result.tokenMissing === true) body.tokenMissing = true;
    await this.call('PATCH', `/devicerequests/${encodeURIComponent(deviceRequestId)}/sendresult`, body, this.deviceHeaders());
  }

  /** `PATCH /devicerequests/:deviceRequestId/guildchannels`. */
  async reportGuildChannels(
    deviceRequestId: string,
    answer: { guilds: GuildChannelsAnswer[]; tokenRejected: boolean },
  ): Promise<void> {
    await this.call(
      'PATCH',
      `/devicerequests/${encodeURIComponent(deviceRequestId)}/guildchannels`,
      { guilds: answer.guilds, tokenRejected: answer.tokenRejected },
      this.deviceHeaders(),
    );
  }

  /**
   * `PATCH /devicerequests/:deviceRequestId/guildchannels` with `{ unavailableReason }`
   * and no `guilds`: the platform answers the user "list unavailable" at once
   * instead of waiting out its 15 s.
   */
  async reportGuildChannelsUnavailable(deviceRequestId: string, reason: GuildChannelsUnavailableReason): Promise<void> {
    await this.call(
      'PATCH',
      `/devicerequests/${encodeURIComponent(deviceRequestId)}/guildchannels`,
      { unavailableReason: reason },
      this.deviceHeaders(),
    );
  }

  /**
   * `GET /deviceexpectedaccounts` - the owner's `connector`-path accounts bound to
   * this device, plus those bound to a revoked device or to none
   * (`boundToThisDevice: false`).
   */
  async listExpectedAccounts(): Promise<ExpectedAccount[]> {
    const data = (await this.call('GET', '/deviceexpectedaccounts', undefined, this.deviceHeaders())) as
      | { accounts?: unknown }
      | null;
    const rows = Array.isArray(data?.accounts) ? (data!.accounts as unknown[]) : [];
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const out: ExpectedAccount[] = [];
    for (const raw of rows) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const discordUserId = str(r.discordUserId);
      if (!discordUserId) continue;
      out.push({
        accountId: str(r.accountId) ?? str(r.id) ?? '',
        discordUserId,
        displayName: (str(r.displayName) ?? discordUserId).slice(0, 100),
        avatarUrl: str(r.avatarUrl),
        status: str(r.status),
        disconnectReason: str(r.disconnectReason),
        boundToThisDevice: r.boundToThisDevice === true,
      });
    }
    return out;
  }

  /**
   * `POST /connectoraccountremovals` - tells the platform this device no longer
   * holds the account's token. `notBound` is a 200 too, so the device can always
   * finish its local removal.
   */
  async removeAccount(discordUserId: string): Promise<AccountRemoval> {
    const data = (await this.call(
      'POST',
      '/connectoraccountremovals',
      { discordUserId: discordUserId.slice(0, 32) },
      this.deviceHeaders(),
    )) as { removal?: Record<string, unknown> | null } | null;
    const r = (data?.removal ?? {}) as Record<string, unknown>;
    return {
      result: r.result === 'released' || r.result === 'notBound' ? r.result : null,
      accountId: typeof r.accountId === 'string' ? r.accountId : null,
    };
  }

  /** `PATCH /connectorselfrevoke` - revokes this device's own credential; every later device call answers 401. */
  async revokeSelf(): Promise<{ id: string | null; revoked: boolean }> {
    const data = (await this.call('PATCH', '/connectorselfrevoke', undefined, this.deviceHeaders())) as
      | Record<string, unknown>
      | null;
    return { id: typeof data?.id === 'string' ? data.id : null, revoked: data?.revoked === true };
  }
}
