import type { AccountMeta, AccountStore, SendResultEntry } from '../src/core/accounts';
import { MAX_RESULTS_PER_ACCOUNT } from '../src/core/accounts';
import { ConnectorApi } from '../src/core/connectorApi';
import { DiscordClient } from '../src/core/discord';
import { type HttpClient, type HttpRequest, type HttpResponse, NetworkError } from '../src/core/http';

export const API_BASE = 'https://connector.test/connector-api';
export const DISCORD_BASE = 'https://discord.test/api/v10';
export const DEVICE = { deviceId: 'dev-1', deviceCredential: 'cred-secret-123456' };
// Synthetic Discord-shaped token, joined at runtime so secret scanners do not flag a fake value.
export const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcdE', 'abcdefghijklmnopqrstuvwxyz0123'].join('.');

type Handler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse> | NetworkError;

/** A routed mock of the HTTP layer; records every call. Never reaches a network. */
export class MockHttp {
  calls: HttpRequest[] = [];
  private routes: Array<{ method: string; match: RegExp; handler: Handler }> = [];

  on(method: string, match: RegExp, handler: Handler): this {
    this.routes.unshift({ method, match, handler });
    return this;
  }

  client: HttpClient = async (req) => {
    this.calls.push(req);
    const route = this.routes.find((r) => r.method === req.method && r.match.test(req.url));
    if (!route) throw new Error(`unrouted ${req.method} ${req.url}`);
    const out = await route.handler(req);
    if (out instanceof NetworkError) throw out;
    return out;
  };

  callsTo(method: string, match: RegExp): HttpRequest[] {
    return this.calls.filter((c) => c.method === method && match.test(c.url));
  }
}

export function json(status: number, data: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, data, headers };
}

export function problem(status: number, errorCode: string, detail = 'x'): HttpResponse {
  return json(status, { type: 'about:blank', title: 'Error', status, detail, errorCode });
}

export class MemoryStore implements AccountStore {
  accounts = new Map<string, AccountMeta>();
  tokens = new Map<string, string>();

  list(): AccountMeta[] {
    return [...this.accounts.values()];
  }
  async getToken(id: string) {
    return this.tokens.get(id) ?? null;
  }
  async save(meta: AccountMeta, token: string) {
    this.accounts.set(meta.discordUserId, { ...meta });
    this.tokens.set(meta.discordUserId, token);
  }
  async update(id: string, patch: Partial<AccountMeta>) {
    const a = this.accounts.get(id);
    if (a) this.accounts.set(id, { ...a, ...patch });
  }
  async recordResult(id: string, entry: SendResultEntry) {
    const a = this.accounts.get(id);
    if (a) a.lastResults = [entry, ...a.lastResults].slice(0, MAX_RESULTS_PER_ACCOUNT);
  }
  async remove(id: string) {
    this.accounts.delete(id);
    this.tokens.delete(id);
  }
}

export function account(discordUserId: string, displayName = 'user'): AccountMeta {
  return {
    discordUserId,
    displayName,
    avatarUrl: null,
    status: 'active',
    statusText: null,
    platformAccountId: null,
    addedAt: new Date(0).toISOString(),
    lastResults: [],
  };
}

export function makeClients(http: MockHttp, paired = true) {
  const api = new ConnectorApi(API_BASE, http.client, () => (paired ? DEVICE : null));
  const discord = new DiscordClient(http.client, DISCORD_BASE);
  return { api, discord };
}
