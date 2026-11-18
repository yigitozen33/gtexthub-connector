import { describe, expect, it } from 'vitest';
import { AccountService, normalizeToken } from '../src/core/accounts';
import { Redactor } from '../src/core/logger';
import { NetworkError } from '../src/core/http';
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

describe('adding a token for an expected account', () => {
  it('stores the token when it belongs to the expected account (re-bind via the usual report)', async () => {
    const { http, store, svc } = setup();
    http.on('POST', REPORT, () => json(200, { registration: { result: 'recovered', accountId: 'acc-9' } }));
    const r = await svc.add(TOKEN, '42');
    expect(r).toMatchObject({ ok: true, registration: { result: 'recovered', accountId: 'acc-9' } });
    expect(store.tokens.get('42')).toBe(TOKEN);
    expect(http.callsTo('POST', REPORT)[0].body).toEqual({ discordUserId: '42', discordUsername: 'neo', tokenValid: true });
  });

  it('refuses a token of another account before reporting anything', async () => {
    const { http, store, svc } = setup();
    const r = await svc.add(TOKEN, '77');
    expect(r).toEqual({ ok: false, message: expect.stringContaining('neo hesabına ait') });
    expect(http.callsTo('POST', REPORT)).toHaveLength(0);
    expect(store.tokens.size).toBe(0);
  });
});

describe('removing an account', () => {
  const REMOVAL = /\/connectoraccountremovals$/;

  it('tells the platform first, then deletes the token', async () => {
    const { http, store, svc } = setup();
    await store.save(account('42'), TOKEN);
    let tokenAtCall: string | undefined;
    http.on('POST', REMOVAL, () => {
      tokenAtCall = store.tokens.get('42');
      return json(200, { removal: { result: 'released', accountId: 'acc-7' } });
    });
    const out = await svc.remove('42');
    expect(out).toEqual({ platform: 'released', accountId: 'acc-7' });
    expect(tokenAtCall).toBe(TOKEN); // the platform was told before the local delete
    expect(http.callsTo('POST', REMOVAL)[0].body).toEqual({ discordUserId: '42' });
    expect(JSON.stringify(http.calls)).not.toContain(TOKEN);
    expect(store.tokens.has('42')).toBe(false);
    expect(store.accounts.has('42')).toBe(false);
  });

  it('treats notBound as success', async () => {
    const { http, store, svc } = setup();
    await store.save(account('42'), TOKEN);
    http.on('POST', REMOVAL, () => json(200, { removal: { result: 'notBound', accountId: null } }));
    expect(await svc.remove('42')).toEqual({ platform: 'notBound', accountId: null });
    expect(store.tokens.has('42')).toBe(false);
  });

  it('still deletes locally when the platform is unreachable', async () => {
    const { http, store, svc } = setup();
    await store.save(account('42'), TOKEN);
    http.on('POST', REMOVAL, () => new NetworkError('ENOTFOUND', false));
    expect(await svc.remove('42')).toEqual({ platform: 'unreachable' });
    expect(store.tokens.has('42')).toBe(false);
  });

  it('still deletes locally when the platform refuses', async () => {
    const { http, store, svc } = setup();
    await store.save(account('42'), TOKEN);
    http.on('POST', REMOVAL, () => json(404, { status: 404 }));
    expect(await svc.remove('42')).toEqual({ platform: 'refused' });
    expect(store.tokens.has('42')).toBe(false);
  });

  it('signals revocation and still deletes the token', async () => {
    const { http, store, svc } = setup();
    await store.save(account('42'), TOKEN);
    http.on('POST', REMOVAL, () => problem(401, 'errMsg_DeviceCredentialInvalid'));
    expect(await svc.remove('42')).toEqual({ platform: 'revoked' });
    expect(store.tokens.has('42')).toBe(false);
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
