import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Redactor, nullLogger } from '../src/core/logger';
import { ConnectorController } from '../src/main/controller';
import type { Encryptor } from '../src/main/storage';
import { NetworkError } from '../src/core/http';
import { API_BASE, MockHttp, TOKEN, json, problem } from './helpers';

const EXPECTED = /\/deviceexpectedaccounts$/;
const REMOVAL = /\/connectoraccountremovals$/;
const SELF_REVOKE = /\/connectorselfrevoke$/;

const expectedRow = (discordUserId: string, displayName: string, boundToThisDevice: boolean) => ({
  accountId: `acc-${discordUserId}`,
  discordUserId,
  displayName,
  avatarUrl: null,
  status: boundToThisDevice ? 'awaitingConnector' : 'disconnected',
  disconnectReason: boundToThisDevice ? null : 'Cihaz kaldırıldı',
  boundToThisDevice,
});

/** Stand-in for safeStorage: reversible, but never plaintext on disk. */
const fakeEncryptor: Encryptor = {
  isAvailable: async () => true,
  encrypt: async (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: async (buf) => ({ result: Buffer.from(buf.map((b) => b ^ 0x5a)).toString('utf8'), shouldReEncrypt: false }),
};

let dir: string;

function makeController(http: MockHttp, encryptor: Encryptor = fakeEncryptor) {
  return new ConnectorController({
    dataDir: dir,
    encryptor,
    logger: nullLogger,
    redactor: new Redactor(),
    apiBase: API_BASE,
    platform: 'macos',
    defaultDeviceName: 'test-mac',
    version: '0.0.0-test',
    environment: 'test',
    getAutoStart: () => false,
    applyAutoStart: () => {},
    http: http.client,
  });
}

function serverMock() {
  return new MockHttp()
    .on('POST', /\/devicepairings$/, () => json(200, { deviceId: 'dev-1', deviceCredential: 'cred-very-secret-1' }))
    .on('PATCH', /\/connectorheartbeat$/, () => json(200, { id: 'dev-1' }))
    .on('GET', /\/devicerequests\/pending$/, () => json(200, { data: [] }))
    .on('GET', /discord\.com\/api\/v10\/users\/@me$/, () => json(200, { id: '42', username: 'neo', avatar: null }))
    .on('POST', /\/connectoraccountreports$/, () => json(200, { registration: { result: 'registered', accountId: 'acc-1' } }))
    .on('GET', EXPECTED, () => json(200, { accounts: [] }))
    .on('POST', REMOVAL, () => json(200, { removal: { result: 'released', accountId: 'acc-1' } }))
    .on('PATCH', SELF_REVOKE, () => json(200, { id: 'dev-1', revoked: true }));
}

async function pairedController(http: MockHttp) {
  const c = makeController(http);
  await c.init();
  await c.pair('abcd-efgh', 'pc');
  await vi.advanceTimersByTimeAsync(0);
  return c;
}

function diskText(): string {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'latin1'))
    .join('\n');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-connector-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConnectorController', () => {
  it('pairs, stores secrets only encrypted, and survives a restart', async () => {
    const http = serverMock();
    const c = makeController(http);
    await c.init();
    expect(c.state().connection).toBe('unpaired');
    expect(c.state().statusLabel).toBe('Eşleştirilmedi');

    const r = await c.pair('abcd-efgh', '');
    expect(r.ok).toBe(true);
    expect(http.callsTo('POST', /devicepairings/)[0].body).toEqual({ code: 'abcd-efgh', deviceName: 'test-mac', platform: 'macos' });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state().statusLabel).toBe('Çalışıyor');

    const add = await c.addAccount(TOKEN);
    expect(add.ok).toBe(true);
    expect(c.state().accounts.map((a) => a.discordUserId)).toEqual(['42']);
    expect(JSON.stringify(c.state())).not.toContain(TOKEN);

    const disk = diskText();
    expect(disk).not.toContain('cred-very-secret-1');
    expect(disk).not.toContain(TOKEN);
    c.shutdown();

    const again = makeController(serverMock());
    await again.init();
    expect(again.state().device?.deviceName).toBe('test-mac');
    expect(again.state().accounts).toHaveLength(1);
    again.shutdown();
  });

  it('wipes credentials and tokens on revocation', async () => {
    const http = serverMock();
    const c = makeController(http);
    await c.init();
    await c.pair('abcd-efgh', 'pc');
    await vi.advanceTimersByTimeAsync(0);
    await c.addAccount(TOKEN);

    http.on('GET', /\/devicerequests\/pending$/, () => problem(401, 'errMsg_DeviceCredentialInvalid'));
    await vi.advanceTimersByTimeAsync(3_000);
    const s = c.state();
    expect(s.connection).toBe('unpaired');
    expect(s.accounts).toHaveLength(0);
    expect(s.notice).toMatch(/eşleştirmesi kaldırılmış/);
    expect(fs.existsSync(path.join(dir, 'secrets.bin'))).toBe(false);
  });

  it('shows Bağlantı yok when the platform is unreachable', async () => {
    const http = serverMock();
    const c = makeController(http);
    await c.init();
    await c.pair('abcd-efgh', 'pc');
    http.on('PATCH', /\/connectorheartbeat$/, () => json(502, {}));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.state().statusLabel).toBe('Bağlantı yok');
    c.shutdown();
  });

  it('deletes the token when an account is removed', async () => {
    const http = serverMock();
    const c = makeController(http);
    await c.init();
    await c.pair('abcd-efgh', 'pc');
    await c.addAccount(TOKEN);
    await c.removeAccount('42');
    c.shutdown();
    const blob = fs.readFileSync(path.join(dir, 'secrets.bin'));
    const { result } = await fakeEncryptor.decrypt(blob);
    expect(JSON.parse(result).tokens).toEqual({});
  });

  it('reports an invalid pairing code', async () => {
    const http = serverMock().on('POST', /\/devicepairings$/, () => json(200, {}));
    const c = makeController(http);
    await c.init();
    const r = await c.pair('abcd-efgh', 'pc');
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/geçersiz/) });
    expect(c.state().connection).toBe('unpaired');
  });

  it('refuses to pair without OS encryption', async () => {
    const http = serverMock();
    const c = makeController(http, { ...fakeEncryptor, isAvailable: async () => false });
    await c.init();
    const r = await c.pair('abcd-efgh', 'pc');
    expect(r.ok).toBe(false);
    expect(http.callsTo('POST', /devicepairings/)).toHaveLength(0);
  });
});

describe('expected accounts (GET /deviceexpectedaccounts)', () => {
  it('lists accounts the platform expects but this device holds no token for, re-pair candidates included', async () => {
    const http = serverMock().on('GET', EXPECTED, () =>
      json(200, { accounts: [expectedRow('42', 'neo', true), expectedRow('43', 'trinity', false)] }),
    );
    const c = await pairedController(http);
    expect(http.callsTo('GET', EXPECTED).length).toBeGreaterThanOrEqual(1); // fetched after pairing
    expect(c.state().expectedAccounts.map((a) => [a.discordUserId, a.boundToThisDevice])).toEqual([
      ['42', true],
      ['43', false],
    ]);

    // Entering the token for the expected account reuses the add flow and drops it from the list.
    const add = await c.addAccount(TOKEN, '42');
    expect(add.ok).toBe(true);
    expect(c.state().expectedAccounts.map((a) => a.discordUserId)).toEqual(['43']);
    expect(c.state().accounts.map((a) => a.discordUserId)).toEqual(['42']);
    const ui = JSON.stringify(c.state());
    expect(ui).not.toContain(TOKEN);
    expect(ui).not.toContain('cred-very-secret-1');
    c.shutdown();
  });

  it('refuses a token of another account when entered for an expected one', async () => {
    const http = serverMock().on('GET', EXPECTED, () => json(200, { accounts: [expectedRow('77', 'morpheus', true)] }));
    const c = await pairedController(http);
    const r = await c.addAccount(TOKEN, '77');
    expect(r.ok).toBe(false);
    expect(http.callsTo('POST', /connectoraccountreports/)).toHaveLength(0);
    expect(c.state().expectedAccounts.map((a) => a.discordUserId)).toEqual(['77']);
    c.shutdown();
  });

  it('re-fetches when the window opens and every 60 s', async () => {
    const http = serverMock();
    const c = await pairedController(http);
    const n = http.callsTo('GET', EXPECTED).length;
    c.windowShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.callsTo('GET', EXPECTED)).toHaveLength(n + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(http.callsTo('GET', EXPECTED)).toHaveLength(n + 2);
    c.shutdown();
  });

  it('shows nothing while unpaired and does not call the platform', async () => {
    const http = serverMock();
    const c = makeController(http);
    await c.init();
    c.windowShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state().expectedAccounts).toEqual([]);
    expect(http.callsTo('GET', EXPECTED)).toHaveLength(0);
  });
});

describe('removal reflected on the platform', () => {
  it('reports the removal (POST /connectoraccountremovals) before deleting the token', async () => {
    const http = serverMock();
    const c = await pairedController(http);
    await c.addAccount(TOKEN);
    const r = await c.removeAccount('42');
    expect(r).toEqual({ ok: true, message: expect.stringMatching(/bildirildi/) });
    expect(http.callsTo('POST', REMOVAL)).toHaveLength(1);
    expect(http.callsTo('POST', REMOVAL)[0].body).toEqual({ discordUserId: '42' });
    expect(c.state().accounts).toHaveLength(0);
    c.shutdown();
    const { result } = await fakeEncryptor.decrypt(fs.readFileSync(path.join(dir, 'secrets.bin')));
    expect(JSON.parse(result).tokens).toEqual({});
  });

  it('still removes locally when the platform is unreachable', async () => {
    const http = serverMock();
    const c = await pairedController(http);
    await c.addAccount(TOKEN);
    http.on('POST', REMOVAL, () => new NetworkError('ECONNREFUSED', false));
    const r = await c.removeAccount('42');
    expect(r).toEqual({ ok: true, message: expect.stringMatching(/bildirilemedi/) });
    expect(c.state().accounts).toHaveLength(0);
    expect(c.state().connection).not.toBe('unpaired');
    c.shutdown();
  });

  it('wipes everything when the removal finds the device revoked', async () => {
    const http = serverMock();
    const c = await pairedController(http);
    await c.addAccount(TOKEN);
    http.on('POST', REMOVAL, () => problem(401, 'errMsg_DeviceCredentialInvalid'));
    await c.removeAccount('42');
    expect(c.state().connection).toBe('unpaired');
    expect(c.state().notice).toMatch(/eşleştirmesi kaldırılmış/);
  });
});

describe('unpair (PATCH /connectorselfrevoke)', () => {
  it('does not count a 404 (no such route on an older backend) as revoked', async () => {
    const http = serverMock().on('PATCH', SELF_REVOKE, () => json(404, { status: 404 }));
    const c = await pairedController(http);
    await c.unpair();
    expect(c.state().connection).toBe('unpaired');
    expect(c.state().notice).toMatch(/Cihazlar sayfasından/);
  });

  it('revokes the device on the platform, then wipes local state', async () => {
    const http = serverMock();
    const c = await pairedController(http);
    await c.addAccount(TOKEN);
    const r = await c.unpair();
    expect(r.ok).toBe(true);
    const revoke = http.callsTo('PATCH', SELF_REVOKE);
    expect(revoke).toHaveLength(1);
    expect(revoke[0].headers?.['x-device-id']).toBe('dev-1');
    expect(revoke[0].headers?.['x-device-credential']).toBe('cred-very-secret-1');
    const s = c.state();
    expect(s.connection).toBe('unpaired');
    expect(s.accounts).toHaveLength(0);
    expect(s.notice).toBeNull();
    expect(fs.existsSync(path.join(dir, 'secrets.bin'))).toBe(false);
    // Nothing runs after the wipe.
    const n = http.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(http.calls.length).toBe(n);
  });

  it('treats a 401 as already revoked (success, no warning)', async () => {
    const http = serverMock().on('PATCH', SELF_REVOKE, () => problem(401, 'errMsg_DeviceCredentialInvalid'));
    const c = await pairedController(http);
    const r = await c.unpair();
    expect(r.ok).toBe(true);
    expect(c.state().connection).toBe('unpaired');
    expect(c.state().notice).toBeNull();
  });

  it('wipes locally on a network failure and tells the user to remove the device on the web panel', async () => {
    const http = serverMock().on('PATCH', SELF_REVOKE, () => new NetworkError('ENOTFOUND', false));
    const c = await pairedController(http);
    await c.addAccount(TOKEN);
    const r = await c.unpair();
    expect(r.ok).toBe(true);
    const s = c.state();
    expect(s.connection).toBe('unpaired');
    expect(s.accounts).toHaveLength(0);
    expect(s.notice).toMatch(/Cihazlar sayfasından/);
    expect(fs.existsSync(path.join(dir, 'secrets.bin'))).toBe(false);
  });
});
