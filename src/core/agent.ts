/**
 * The device loop (service-spec-connector, "Device protocol", with the settled
 * transport: the realtime hub was not built, so the device polls).
 *
 *   - heartbeat `PATCH /connectorheartbeat` every 30 s (offline after 2 min without one);
 *   - poll `GET /devicerequests/pending` every 3 s while online;
 *   - each request is handled once (journal keyed by request id);
 *   - handOff: send through Discord, then `reportConnectorSendResult`;
 *   - guildChannels: list through Discord, answer `reportConnectorGuildChannels` within 15 s;
 *   - network loss / 5xx: status offline, exponential back-off probes, automatic recovery;
 *   - 401 errMsg_DeviceCredentialInvalid: stop and raise `onRevoked`.
 *
 * Send delay, banned words and license checks are enforced by the platform
 * before a hand-off; the agent only executes hand-offs.
 */
import type { AccountStore } from './accounts';
import {
  type ConnectorApi,
  ConnectorApiError,
  DeviceRevokedError,
  type GuildChannelsAnswer,
  isConnectivityError,
  type PendingRequest,
} from './connectorApi';
import { type DiscordClient, type DiscordResult, fail } from './discord';
import { type JournalResult, RequestJournal } from './journal';
import { type Logger, nullLogger } from './logger';

export type AgentStatus = 'stopped' | 'connecting' | 'online' | 'offline' | 'revoked';

export interface AgentTimings {
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Budget for answering a guild-channel request (the platform waits 15 s). */
  guildChannelsBudgetMs: number;
  /** How long a result report is retried through a connectivity loss (the platform accepts results for 5 min). */
  resultRetryWindowMs: number;
}

export const DEFAULT_TIMINGS: AgentTimings = {
  heartbeatIntervalMs: 30_000,
  pollIntervalMs: 3_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  guildChannelsBudgetMs: 12_000,
  resultRetryWindowMs: 5 * 60_000,
};

export const PAUSED_REASON = 'Gönderim bağlayıcıda duraklatıldı';

export interface HandledRequestInfo {
  requestId: string;
  kind: PendingRequest['kind'];
  discordUserId: string | null;
  outcome: 'sent' | 'failed' | 'listed' | 'unanswered';
  reason: string | null;
}

export interface AgentHooks {
  onStatus?(status: AgentStatus): void;
  /** The credential is dead; the caller wipes local state and asks to pair again. */
  onRevoked?(): void;
  /** Fired on every transition to online (first = the first since start). */
  onOnline?(first: boolean): void;
  onRequestHandled?(info: HandledRequestInfo): void;
}

export interface AgentDeps {
  api: ConnectorApi;
  discord: DiscordClient;
  store: AccountStore;
  journal?: RequestJournal;
  logger?: Logger;
  isPaused?: () => boolean;
  hooks?: AgentHooks;
  timings?: Partial<AgentTimings>;
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DeviceAgent {
  private readonly api: ConnectorApi;
  private readonly discord: DiscordClient;
  private readonly store: AccountStore;
  readonly journal: RequestJournal;
  private readonly logger: Logger;
  private readonly isPaused: () => boolean;
  private readonly hooks: AgentHooks;
  private readonly t: AgentTimings;
  private readonly now: () => number;

  private _status: AgentStatus = 'stopped';
  private hbTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private wentOnlineOnce = false;
  private heartbeatInFlight = false;
  private pollInFlight = false;

  constructor(deps: AgentDeps) {
    this.api = deps.api;
    this.discord = deps.discord;
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    this.journal = deps.journal ?? new RequestJournal(null, this.now);
    this.logger = deps.logger ?? nullLogger;
    this.isPaused = deps.isPaused ?? (() => false);
    this.hooks = deps.hooks ?? {};
    this.t = { ...DEFAULT_TIMINGS, ...(deps.timings ?? {}) };
  }

  get status(): AgentStatus {
    return this._status;
  }

  private get active(): boolean {
    return this._status === 'connecting' || this._status === 'online' || this._status === 'offline';
  }

  start(): void {
    if (this.active) return;
    this.failures = 0;
    this.wentOnlineOnce = false;
    this.setStatus('connecting');
    // Results finished before a restart but never reported.
    for (const e of this.journal.unreported()) {
      if (e.result) void this.deliverSendResult(e.id, e.result);
    }
    void this.heartbeatTick();
  }

  stop(): void {
    this.clearTimers();
    if (this._status !== 'revoked') this.setStatus('stopped');
  }

  private setStatus(s: AgentStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.hooks.onStatus?.(s);
  }

  private clearTimers(): void {
    if (this.hbTimer) clearTimeout(this.hbTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.hbTimer = null;
    this.pollTimer = null;
  }

  private scheduleHeartbeat(ms: number): void {
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.hbTimer = setTimeout(() => {
      this.hbTimer = null;
      void this.heartbeatTick();
    }, ms);
  }

  private schedulePoll(ms: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollTick();
    }, ms);
  }

  private async heartbeatTick(): Promise<void> {
    if (!this.active || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      await this.api.heartbeat();
      if (!this.active) return;
      const wasOnline = this._status === 'online';
      this.failures = 0;
      this.scheduleHeartbeat(this.t.heartbeatIntervalMs);
      if (!wasOnline) {
        this.setStatus('online');
        const first = !this.wentOnlineOnce;
        this.wentOnlineOnce = true;
        this.logger.info(first ? 'connected' : 'reconnected');
        // Catch up at once on every (re)connect.
        this.schedulePoll(0);
        this.hooks.onOnline?.(first);
      }
    } catch (err) {
      this.onLoopError(err, 'heartbeat');
      if (this._status === 'online') this.scheduleHeartbeat(this.t.heartbeatIntervalMs);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async pollTick(): Promise<void> {
    if (this._status !== 'online' || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const requests = await this.api.listPending();
      this.journal.prune();
      for (const req of requests) this.dispatch(req);
      if (this._status === 'online') this.schedulePoll(this.t.pollIntervalMs);
    } catch (err) {
      this.onLoopError(err, 'poll');
      if (this._status === 'online') this.schedulePoll(this.t.pollIntervalMs);
    } finally {
      this.pollInFlight = false;
    }
  }

  private onLoopError(err: unknown, where: string): void {
    if (err instanceof DeviceRevokedError) {
      this.revoke();
      return;
    }
    if (isConnectivityError(err)) {
      this.goOffline(where, err);
      return;
    }
    // Another 4xx: the call shape or the platform state; keep the cadence.
    this.logger.warn(`${where} refused`, {
      status: (err as ConnectorApiError)?.status,
      errorCode: (err as ConnectorApiError)?.errorCode,
      error: err instanceof ConnectorApiError ? undefined : String(err),
    });
  }

  private goOffline(where: string, err: unknown): void {
    if (!this.active) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const delay = Math.min(this.t.backoffBaseMs * 2 ** this.failures, this.t.backoffMaxMs);
    this.failures += 1;
    if (this._status !== 'offline') {
      this.logger.warn('connection lost', { where, error: (err as Error)?.message });
      this.setStatus('offline');
    }
    this.scheduleHeartbeat(delay);
  }

  private revoke(): void {
    if (this._status === 'revoked') return;
    this.clearTimers();
    this.logger.warn('device credential refused (revoked); stopping');
    this.setStatus('revoked');
    this.hooks.onRevoked?.();
  }

  /** Handles a request once; later listings of the same id are ignored. */
  private dispatch(req: PendingRequest): void {
    if (this.journal.has(req.id)) return;
    this.journal.start(req.id, req.kind);
    const work = req.kind === 'handOff' ? this.handleHandOff(req) : this.handleGuildChannels(req);
    work.catch((err) => {
      if (err instanceof DeviceRevokedError) this.revoke();
      else this.logger.error('request handling failed', { requestId: req.id, kind: req.kind, error: String(err) });
    });
  }

  private async handleHandOff(req: PendingRequest): Promise<void> {
    const p = req.payload ?? {};
    const discordUserId = typeof p.discordUserId === 'string' ? p.discordUserId : null;
    const channelId = typeof p.discordChannelId === 'string' ? p.discordChannelId : null;
    const text = typeof p.text === 'string' ? p.text : null;

    let res: DiscordResult;
    if (!discordUserId || !channelId || !text) {
      res = { ...fail('discordError', { note: 'eksik istek verisi' }) };
    } else if (this.isPaused()) {
      res = { ...fail('discordError'), reason: PAUSED_REASON, detailedReason: PAUSED_REASON };
    } else {
      const token = await this.store.getToken(discordUserId);
      res = token ? await this.discord.sendMessage(token, channelId, text) : fail('noToken');
    }

    const result: JournalResult = res.failure
      ? {
          outcome: 'failed',
          reason: String(res.detailedReason || res.reason || 'Gönderilemedi').slice(0, 500),
          tokenRejected: res.failure === 'tokenRejected',
        }
      : { outcome: 'sent', reason: null, tokenRejected: false };
    this.journal.setResult(req.id, result);

    if (res.failure) {
      this.logger.warn('DiscordSendFailed', {
        requestId: req.id,
        sendRecordId: req.sendRecordId ?? null,
        discordUserId,
        discordChannelId: channelId,
        failure: res.failure,
        httpStatus: res.status || null,
        discordCode: res.discordCode,
        discordMessage: res.detail,
        networkError: res.networkError,
      });
    } else {
      this.logger.info('sent', { requestId: req.id, sendRecordId: req.sendRecordId ?? null, discordUserId });
    }

    if (discordUserId && this.store.list().some((a) => a.discordUserId === discordUserId)) {
      await this.store.recordResult(discordUserId, {
        at: new Date(this.now()).toISOString(),
        kind: 'handOff',
        outcome: result.outcome,
        reason: result.reason,
        discordChannelId: channelId,
      });
      if (result.tokenRejected) {
        await this.store.update(discordUserId, { status: 'tokenRejected', statusText: 'Discord tokeni reddetti' });
      }
    }
    this.hooks.onRequestHandled?.({
      requestId: req.id,
      kind: 'handOff',
      discordUserId,
      outcome: result.outcome,
      reason: result.reason,
    });
    await this.deliverSendResult(req.id, result);
  }

  private async handleGuildChannels(req: PendingRequest): Promise<void> {
    const discordUserId = typeof req.payload?.discordUserId === 'string' ? req.payload.discordUserId : null;
    const token = discordUserId ? await this.store.getToken(discordUserId) : null;
    if (!token) {
      // Not an account of this device: no answer; the platform's wait times out
      // and the user can enter the channel id by hand.
      this.logger.warn('guild channel request for an account not held here', { requestId: req.id, discordUserId });
      this.hooks.onRequestHandled?.({ requestId: req.id, kind: 'guildChannels', discordUserId, outcome: 'unanswered', reason: 'noToken' });
      return;
    }
    const listed = await this.discord.listGuildChannels(token, this.t.guildChannelsBudgetMs);
    if (!listed.ok && listed.failure !== 'tokenRejected') {
      // Discord unreachable or rate limited: an empty "listed" answer would
      // mislead; let the platform's wait time out instead.
      this.logger.warn('guild channel listing failed', { requestId: req.id, failure: listed.failure });
      this.hooks.onRequestHandled?.({ requestId: req.id, kind: 'guildChannels', discordUserId, outcome: 'unanswered', reason: listed.reason });
      return;
    }
    const tokenRejected = listed.failure === 'tokenRejected';
    // Both channel keys: the connector spec names `channelId`, while the web
    // client and the platform path read `discordChannelId`.
    const guilds: GuildChannelsAnswer[] = listed.guilds.map((g) => ({
      guildId: g.guildId,
      guildName: g.guildName,
      channels: g.channels.map((c) => ({
        channelId: c.discordChannelId,
        discordChannelId: c.discordChannelId,
        channelName: c.channelName,
      })),
    }));
    if (tokenRejected) {
      await this.store.update(discordUserId!, { status: 'tokenRejected', statusText: 'Discord tokeni reddetti' });
    }
    await this.deliver(req.id, () => this.api.reportGuildChannels(req.id, { guilds, tokenRejected }), this.t.guildChannelsBudgetMs);
    this.hooks.onRequestHandled?.({
      requestId: req.id,
      kind: 'guildChannels',
      discordUserId,
      outcome: 'listed',
      reason: tokenRejected ? 'Discord tokeni reddetti' : null,
    });
  }

  private async deliverSendResult(requestId: string, result: JournalResult): Promise<void> {
    const done = await this.deliver(
      requestId,
      () => this.api.reportSendResult(requestId, result),
      this.t.resultRetryWindowMs,
    );
    if (done) this.journal.markReported(requestId);
  }

  /**
   * Reports an answer, retrying through connectivity loss for `windowMs`.
   * 409 (already recorded or late) and 404 (gone) count as done. Returns true
   * when the platform has the answer or will never take it.
   */
  private async deliver(requestId: string, send: () => Promise<void>, windowMs: number): Promise<boolean> {
    const started = this.now();
    let attempt = 0;
    for (;;) {
      if (this._status === 'revoked' || this._status === 'stopped') return false;
      try {
        await send();
        return true;
      } catch (err) {
        if (err instanceof DeviceRevokedError) {
          this.revoke();
          return false;
        }
        if (err instanceof ConnectorApiError && !isConnectivityError(err)) {
          if (err.status === 409 || err.status === 404) {
            this.logger.info('answer already recorded or too late', { requestId, status: err.status, errorCode: err.errorCode });
          } else {
            this.logger.warn('answer refused', { requestId, status: err.status, errorCode: err.errorCode });
          }
          return true;
        }
        const delay = Math.min(this.t.backoffBaseMs * 2 ** attempt, 30_000);
        attempt += 1;
        if (this.now() - started + delay > windowMs) {
          this.logger.warn('answer not delivered in time', { requestId });
          return false;
        }
        await sleep(delay);
      }
    }
  }
}
