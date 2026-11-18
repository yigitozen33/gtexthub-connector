/**
 * Discord calls, made the way the platform's own module makes them
 * (export/.../services/discord/src/lib/functions/discordRequest.js and its
 * siblings validateDiscordToken.js, listGuildChannels.js, releaseQueuedSend.js):
 *
 * - base https://discord.com/api/v10, `Authorization: <token>` (raw token, as the
 *   platform sends it), `Accept: application/json`, and the same User-Agent
 *   string the platform module sends; nothing else. No client fingerprint
 *   headers, no randomized timing.
 * - the same endpoints: GET /users/@me, GET /users/@me/guilds,
 *   GET /guilds/{id}/channels, POST /channels/{id}/messages { content }.
 * - the same 15 s timeout and the same failure mapping (401 tokenRejected,
 *   403 forbidden, 404 notFound, 429 rateLimited, else discordError) with the
 *   same Turkish labels and the same `detailedReason` line:
 *   `<label> (Discord <status>[ · <code>][ · <message>])`.
 *
 * Rate limits are handled more conservatively than the platform module (which
 * simply fails on 429): a 429 also starts a per-token cool-down for Discord's
 * `retry_after`; calls inside the cool-down fail as rateLimited without
 * reaching Discord. Nothing is retried automatically.
 */
import { type HttpClient, NetworkError } from './http';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Identical to the User-Agent of the platform's discordRequest.js. */
export const PLATFORM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15_000;
const DETAIL_CAP = 120;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 10 * 60_000;

export type DiscordFailure =
  | 'tokenRejected'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'noToken'
  | 'discordError';

export interface DiscordResult<T = unknown> {
  status: number;
  data: T | null;
  failure: DiscordFailure | null;
  /** The bare Turkish label (null on success). */
  reason: string | null;
  /** Discord's own message, scrubbed of the token, max 300 characters. */
  detail: string | null;
  /** Discord's JSON error code (0 omitted). */
  discordCode: number | null;
  networkError: string | null;
  /** The label plus the detail in parentheses, as the platform stores it on a failed send. */
  detailedReason: string | null;
}

function labelFor(failure: DiscordFailure): string | null {
  if (failure === 'tokenRejected') return 'Discord tokeni reddetti';
  if (failure === 'forbidden') return 'İzin yok';
  if (failure === 'notFound') return 'Kanal bulunamadı';
  if (failure === 'rateLimited') return 'Discord hız sınırı';
  if (failure === 'noToken') return 'Hesabın tokeni yok';
  return null;
}

function oneLine(s: string): string {
  return String(s)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function capped(s: string): string {
  const t = oneLine(s);
  return t.length > DETAIL_CAP ? t.slice(0, DETAIL_CAP - 1) + '…' : t;
}

interface FailInfo {
  status?: number;
  discordCode?: number | null;
  detail?: string | null;
  networkError?: string | null;
  note?: string | null;
}

/** Port of the platform's `fail()`: same labels, same detailedReason format. */
export function fail(failure: DiscordFailure, info: FailInfo = {}): DiscordResult<never> {
  const status = info.status || 0;
  const label = labelFor(failure);
  let reason = label;
  if (!reason) reason = status ? `Discord hatası (HTTP ${status})` : "Discord'a ulaşılamadı";

  let appended: string | null = null;
  if (status) {
    const parts = [`Discord ${status}`];
    if (info.discordCode) parts.push(String(info.discordCode));
    if (info.detail) parts.push(info.detail);
    appended = parts.join(' · ');
  } else if (info.networkError) {
    appended = `ağ hatası: ${info.networkError}`;
  } else if (info.note) {
    appended = info.note;
  }
  const base = label || (status ? 'Discord hatası' : "Discord'a ulaşılamadı");
  const detailedReason = appended ? `${base} (${capped(appended)})` : base;
  return {
    status,
    data: null,
    failure,
    reason,
    detail: info.detail || null,
    discordCode: info.discordCode || null,
    networkError: info.networkError || null,
    detailedReason,
  };
}

function networkErrorOf(err: NetworkError): string {
  if (err.timedOut) return 'zaman aşımı';
  if (/^[A-Z][A-Z0-9_]{1,39}$/.test(err.code) && err.code !== 'CONNECTION_ERROR') return err.code;
  return 'bağlantı hatası';
}

function retryAfterMs(data: unknown, headers: Record<string, string>): number {
  const body = data as { retry_after?: unknown } | null;
  let seconds: number | null = null;
  if (body && typeof body.retry_after === 'number' && isFinite(body.retry_after)) seconds = body.retry_after;
  else if (headers['retry-after'] && isFinite(Number(headers['retry-after']))) seconds = Number(headers['retry-after']);
  const ms = seconds !== null && seconds > 0 ? Math.ceil(seconds * 1000) : DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export interface DiscordUser {
  discordUserId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface GuildWithChannels {
  guildId: string;
  guildName: string;
  channels: Array<{ discordChannelId: string; channelName: string }>;
}

export class DiscordClient {
  /** Per-token cool-down end (epoch ms) after a 429. Keyed by the token in memory only. */
  private cooldownUntil = new Map<string, number>();

  constructor(
    private readonly http: HttpClient,
    private readonly base: string = DISCORD_API_BASE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Port of discordRequest(): one call with the given token. */
  async request<T = unknown>(
    token: string | null | undefined,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<DiscordResult<T>> {
    if (!token) return fail('noToken');
    const until = this.cooldownUntil.get(token) ?? 0;
    const now = this.now();
    if (until > now) {
      return fail('rateLimited', { note: `${Math.ceil((until - now) / 1000)} sn bekleniyor` });
    }
    if (until) this.cooldownUntil.delete(token);

    const scrub = (text: string) => oneLine(text).split(token).join('***');
    const headers: Record<string, string> = {
      Authorization: token,
      Accept: 'application/json',
      'User-Agent': PLATFORM_USER_AGENT,
    };
    let res;
    try {
      res = await this.http({
        method,
        url: this.base.replace(/\/+$/, '') + path,
        headers,
        body,
        timeoutMs: Math.max(1000, Math.min(timeoutMs, REQUEST_TIMEOUT_MS)),
      });
    } catch (err) {
      if (err instanceof NetworkError) return fail('discordError', { networkError: networkErrorOf(err) });
      return fail('discordError', { networkError: 'bağlantı hatası' });
    }
    const status = res.status;
    if (status >= 200 && status < 300) {
      return {
        status,
        data: res.data as T,
        failure: null,
        reason: null,
        detail: null,
        discordCode: null,
        networkError: null,
        detailedReason: null,
      };
    }
    const data = res.data as { message?: unknown; code?: unknown } | null;
    const detail =
      data && typeof data.message === 'string' && data.message.trim() ? scrub(data.message).slice(0, 300) : null;
    const discordCode =
      data && typeof data.code === 'number' && isFinite(data.code) && data.code !== 0 ? data.code : null;
    const info: FailInfo = { status, discordCode, detail };
    if (status === 401) return fail('tokenRejected', info);
    if (status === 403) return fail('forbidden', info);
    if (status === 404) return fail('notFound', info);
    if (status === 429) {
      this.cooldownUntil.set(token, this.now() + retryAfterMs(res.data, res.headers));
      return fail('rateLimited', info);
    }
    return fail('discordError', info);
  }

  /** Port of validateDiscordToken(): GET /users/@me. */
  async validateToken(
    token: string,
  ): Promise<{ ok: true; user: DiscordUser } | { ok: false; result: DiscordResult<never> }> {
    const res = await this.request<{ id?: string; username?: string; global_name?: string | null; avatar?: string | null }>(
      token,
      'GET',
      '/users/@me',
    );
    if (res.failure) return { ok: false, result: res as DiscordResult<never> };
    const me = res.data ?? {};
    if (!me.id) {
      return {
        ok: false,
        result: { ...fail('discordError'), reason: 'Discord yanıtı okunamadı', detailedReason: 'Discord yanıtı okunamadı' },
      };
    }
    const displayName = String(me.global_name || me.username || me.id).slice(0, 100);
    const avatarUrl = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}${String(me.avatar).startsWith('a_') ? '.gif' : '.png'}`
      : null;
    return { ok: true, user: { discordUserId: String(me.id), displayName, avatarUrl } };
  }

  /** The send step of releaseQueuedSend(): POST /channels/{id}/messages { content }. */
  async sendMessage(token: string | null, discordChannelId: string, text: string): Promise<DiscordResult> {
    if (!/^\d{1,32}$/.test(discordChannelId)) {
      return fail('notFound', { note: 'geçersiz kanal kimliği' });
    }
    return this.request(token, 'POST', `/channels/${discordChannelId}/messages`, { content: text });
  }

  /**
   * Port of listGuildChannels(): GET /users/@me/guilds, then GET /guilds/{id}/channels
   * for the first 100 guilds, 4 at a time; text and announcement channels
   * (types 0 and 5) ordered by position; a guild whose channels cannot be read
   * is skipped; a rejected token stops the walk. `deadlineMs` bounds the whole
   * walk (the platform waits 15 s for a connector answer): guilds not reached
   * in time are left out.
   */
  async listGuildChannels(
    token: string | null,
    deadlineMs: number,
  ): Promise<{ ok: boolean; guilds: GuildWithChannels[]; failure: DiscordFailure | null; reason: string | null }> {
    const deadline = this.now() + deadlineMs;
    const remaining = () => deadline - this.now();
    const first = await this.request<Array<{ id: string; name?: string }>>(token, 'GET', '/users/@me/guilds', undefined, remaining());
    if (first.failure) return { ok: false, guilds: [], failure: first.failure, reason: first.reason };
    const guildList = (Array.isArray(first.data) ? first.data : []).slice(0, 100);
    const result: GuildWithChannels[] = [];
    let next = 0;
    let tokenRejected = false;

    const worker = async () => {
      while (next < guildList.length && !tokenRejected && remaining() > 1000) {
        const guild = guildList[next];
        next += 1;
        const res = await this.request<Array<{ id: string; name?: string; type?: number; position?: number }>>(
          token,
          'GET',
          `/guilds/${guild.id}/channels`,
          undefined,
          remaining(),
        );
        if (res.failure === 'tokenRejected') {
          tokenRejected = true;
        } else if (!res.failure && Array.isArray(res.data)) {
          const channels = res.data
            .filter((c) => c && (c.type === 0 || c.type === 5))
            .sort((a, b) => (a.position || 0) - (b.position || 0))
            .map((c) => ({ discordChannelId: String(c.id), channelName: String(c.name || '').slice(0, 100) }));
          result.push({ guildId: String(guild.id), guildName: String(guild.name || '').slice(0, 100), channels });
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (tokenRejected) return { ok: false, guilds: [], failure: 'tokenRejected', reason: 'Discord tokeni reddetti' };
    result.sort((a, b) => a.guildName.localeCompare(b.guildName, 'tr'));
    return { ok: true, guilds: result, failure: null, reason: null };
  }
}
