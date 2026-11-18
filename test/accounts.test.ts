import { describe, expect, it } from 'vitest';
import { AccountService, normalizeToken } from '../src/core/accounts';
import { Redactor } from '../src/core/logger';
import { MemoryStore, MockHttp, TOKEN, account, json, makeClients, problem } from './helpers';

const ME = /\/users\/@me$/;
const REPORT = /\/connectoraccountreports$/;

function setup() {
  const http = new MockHttp().on('GET', ME, () => json(200, { id: '42', username: 'neo', global_name: null, avatar: null }));
  const { api, discord } = makeClients(http);
  const store = new MemoryStore();
  return { http, store, svc: new AccountService(api, discord, store) };
}

describe('adding an account', () => {
  it('validates locally, reports without the token, then stores the token', async () => {
    const { http, store, svc } = setup();
    http.on('POST', REPORT, () => json(200, { registration: { result: 'registered', accountId: 'acc-7' } }));
    const r = await svc.add(`  "${TOKEN}" `);
    expect(r.ok).toBe(true);
    expect(store.tokens.get('42')).toBe(TOKEN);
    expect(store.accounts.get('42')).toMatchObject({ displayName: 'neo', platformAccountId: 'acc-7', status: 'active' });
    const report = http.callsTo('POST', REPORT)[0];
    expect(report.body).toEqual({ discordUserId: '42', discordUsername: 'neo', tokenValid: true });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('does not report or store a token Discord rejects', async () => {
    const { http, store, svc } = setup();
    http.on('GET', ME, () => json(401, { message: '401: Unauthorized', code: 0 }));
    const r = await svc.add(TOKEN);
    expect(r).toEqual({ ok: false, message: 'Discord bu tokeni reddetti. Tokeni kontrol edin.' });
    expect(http.callsTo('POST', REPORT)).toHaveLength(0);
    expect(store.tokens.size).toBe(0);
  });

  it('does not store the token when the platform refuses the account', async () => {
    const { http, store, svc } = setup();
    http.on('POST', REPORT, () => problem(409, 'errMsg_AccountLimitReached'));
    const r = await svc.add(TOKEN);
    expect(r).toEqual({ ok: false, message: 'Lisansınızın hesap sınırına ulaşıldı.' });
    expect(store.tokens.size).toBe(0);
  });

  it('signals revocation', async () => {
    const { http, svc } = setup();
    http.on('POST', REPORT, () => problem(401, 'errMsg_DeviceCredentialInvalid'));
    const r = await svc.add(TOKEN);
    expect(r).toMatchObject({ ok: false, revoked: true });
  });
});

describe('re-validation', () => {
  it('reports tokenValid=false for a token Discord now rejects', async () => {
    const { http, store, svc } = setup();
    await store.save(account('42'), TOKEN);
    http.on('GET', ME, () => json(401, { message: '401: Unauthorized' }));
    http.on('POST', REPORT, () => json(200, { registration: { result: 'disconnected', accountId: 'acc-7' } }));
    await svc.revalidateAll();
    expect(http.callsTo('POST', REPORT)[0].body).toEqual({ discordUserId: '42', discordUsername: 'user', tokenValid: false });
    expect(store.accounts.get('42')?.status).toBe('tokenRejected');
  });
});

describe('helpers', () => {
  it('normalizes pasted tokens', () => {
    expect(normalizeToken(` '${TOKEN}'\n`)).toBe(TOKEN);
  });

  it('redacts registered secrets, token shapes and secret keys', () => {
    const r = new Redactor();
    r.add('cred-secret-123456');
    expect(r.text('x cred-secret-123456 y')).toBe('x *** y');
    expect(r.text(`token ${TOKEN}`)).toBe('token ***');
    expect(r.value({ headers: { 'x-device-credential': 'abc', other: 'ok' } })).toEqual({
      headers: { 'x-device-credential': '***', other: 'ok' },
    });
  });
});
