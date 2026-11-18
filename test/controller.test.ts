import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Redactor, nullLogger } from '../src/core/logger';
import { ConnectorController } from '../src/main/controller';
import type { Encryptor } from '../src/main/storage';
import { API_BASE, MockHttp, TOKEN, json, problem } from './helpers';

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
    .on('POST', /\/connectoraccountreports$/, () => json(200, { registration: { result: 'registered', accountId: 'acc-1' } }));
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
