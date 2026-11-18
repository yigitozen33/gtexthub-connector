import { describe, expect, it } from 'vitest';
import {
  ConnectorApi,
  ConnectorApiError,
  DeviceRevokedError,
  PairingCodeInvalidError,
  PairingThrottledError,
} from '../src/core/connectorApi';
import { NetworkError } from '../src/core/http';
import { API_BASE, DEVICE, MockHttp, json, problem } from './helpers';

describe('pairing', () => {
  it('redeems a code and returns the device credential once', async () => {
    const http = new MockHttp().on('POST', /\/devicepairings$/, () =>
      json(200, { _type: 'pairingCode', id: 'pc1', deviceId: 'dev-9', deviceCredential: 'c-xyz' }),
    );
    const api = new ConnectorApi(API_BASE, http.client, () => null);
    const creds = await api.pair('  abcd-efgh ', 'My PC', 'macos');
    expect(creds).toEqual({ deviceId: 'dev-9', deviceCredential: 'c-xyz' });
    const call = http.calls[0];
    expect(call.url).toBe(`${API_BASE}/devicepairings`);
    expect(call.body).toEqual({ code: 'abcd-efgh', deviceName: 'My PC', platform: 'macos' });
    // The pairing door carries no device headers.
    expect(call.headers?.['x-device-id']).toBeUndefined();
    expect(call.headers?.['x-device-credential']).toBeUndefined();
  });

  it('treats a 200 `{}` answer (onNotFound: complete) as an invalid code', async () => {
    const http = new MockHttp().on('POST', /\/devicepairings$/, () => json(200, {}));
    const api = new ConnectorApi(API_BASE, http.client, () => null);
    await expect(api.pair('ZZZZ-ZZZZ', 'PC', 'windows')).rejects.toBeInstanceOf(PairingCodeInvalidError);
  });

  it('treats a code row without deviceCredential as an invalid code', async () => {
    const http = new MockHttp().on('POST', /\/devicepairings$/, () => json(200, { _type: 'pairingCode', id: 'x' }));
    const api = new ConnectorApi(API_BASE, http.client, () => null);
    await expect(api.pair('ZZZZ-ZZZZ', 'PC', 'windows')).rejects.toBeInstanceOf(PairingCodeInvalidError);
  });

  it('treats 404 errMsg_PairingCodeInvalid as an invalid code', async () => {
    const http = new MockHttp().on('POST', /\/devicepairings$/, () => problem(404, 'errMsg_PairingCodeInvalid'));
    const api = new ConnectorApi(API_BASE, http.client, () => null);
    await expect(api.pair('ZZZZ-ZZZZ', 'PC', 'windows')).rejects.toBeInstanceOf(PairingCodeInvalidError);
  });

  it('treats 429 errMsg_PairingThrottled as a throttle, not as an invalid code', async () => {
    const http = new MockHttp().on('POST', /\/devicepairings$/, () => problem(429, 'errMsg_PairingThrottled'));
    const api = new ConnectorApi(API_BASE, http.client, () => null);
    const err = await api.pair('ZZZZ-ZZZZ', 'PC', 'windows').catch((e) => e);
    expect(err).toBeInstanceOf(PairingThrottledError);
    expect(err).not.toBeInstanceOf(PairingCodeInvalidError);
    expect(http.calls).toHaveLength(1); // no automatic retry
  });

  it('truncates the device name to 64 characters', async () => {
    const http = new MockHttp().on('POST', /\/devicepairings$/, () => json(200, { deviceId: 'd', deviceCredential: 'c' }));
    const api = new ConnectorApi(API_BASE, http.client, () => null);
    await api.pair('A', 'x'.repeat(80), 'windows');
    expect((http.calls[0].body as { deviceName: string }).deviceName).toHaveLength(64);
  });

  it('passes a network failure through', async () => {
    const http = new MockHttp().on('POST', /\/devicepairings$/, () => new NetworkError('ENOTFOUND', false));
    const api = new ConnectorApi(API_BASE, http.client, () => null);
    await expect(api.pair('A', 'PC', 'windows')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('device doors', () => {
  it('sends the device headers on every device call', async () => {
    const http = new MockHttp()
      .on('PATCH', /\/connectorheartbeat$/, () => json(200, { id: 'dev-1', online: true }))
      .on('GET', /\/devicerequests\/pending$/, () => json(200, { data: [], paging: {} }));
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    await api.heartbeat();
    await api.listPending();
    for (const c of http.calls) {
      expect(c.headers?.['x-device-id']).toBe(DEVICE.deviceId);
      expect(c.headers?.['x-device-credential']).toBe(DEVICE.deviceCredential);
    }
  });

  it('maps 401 errMsg_DeviceCredentialInvalid to DeviceRevokedError', async () => {
    const http = new MockHttp().on('PATCH', /\/connectorheartbeat$/, () =>
      problem(401, 'errMsg_DeviceCredentialInvalid', 'Device credential invalid.'),
    );
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    await expect(api.heartbeat()).rejects.toBeInstanceOf(DeviceRevokedError);
  });

  it('reports an account without any token field', async () => {
    const http = new MockHttp().on('POST', /\/connectoraccountreports$/, () =>
      json(200, { _type: 'connectorDevice', id: 'dev-1', registration: { result: 'registered', accountId: 'acc-1' } }),
    );
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    const reg = await api.reportAccount({ discordUserId: '42', discordUsername: 'neo', avatarUrl: null, tokenValid: true });
    expect(reg).toEqual({ result: 'registered', accountId: 'acc-1' });
    expect(http.calls[0].body).toEqual({ discordUserId: '42', discordUsername: 'neo', tokenValid: true });
  });

  it('omits the reason of a sent result and caps a failure reason at 500', async () => {
    const http = new MockHttp().on('PATCH', /\/sendresult$/, () => json(200, { id: 'r', status: 'answered' }));
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    await api.reportSendResult('r1', { outcome: 'sent', reason: 'ignored', tokenRejected: false });
    await api.reportSendResult('r2', { outcome: 'failed', reason: 'y'.repeat(600), tokenRejected: false });
    expect(http.calls[0].url).toBe(`${API_BASE}/devicerequests/r1/sendresult`);
    expect(http.calls[0].body).toEqual({ outcome: 'sent', tokenRejected: false });
    expect((http.calls[1].body as { reason: string }).reason).toHaveLength(500);
  });
});

describe('R19 device doors', () => {
  it('lists expected accounts with device headers and normalizes the rows', async () => {
    const http = new MockHttp().on('GET', /\/deviceexpectedaccounts$/, () =>
      json(200, {
        accounts: [
          {
            accountId: 'acc-1',
            discordUserId: '42',
            displayName: 'neo',
            avatarUrl: 'https://cdn.discordapp.com/avatars/42/a.png',
            status: 'awaitingConnector',
            disconnectReason: null,
            boundToThisDevice: true,
          },
          { accountId: 'acc-2', discordUserId: '43', displayName: 'trinity', boundToThisDevice: false, status: 'disconnected', disconnectReason: 'device-revoked' },
          { accountId: 'acc-3' }, // no discordUserId: dropped
        ],
      }),
    );
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    const rows = await api.listExpectedAccounts();
    expect(http.calls[0].url).toBe(`${API_BASE}/deviceexpectedaccounts`);
    expect(http.calls[0].headers?.['x-device-id']).toBe(DEVICE.deviceId);
    expect(http.calls[0].headers?.['x-device-credential']).toBe(DEVICE.deviceCredential);
    expect(rows).toEqual([
      {
        accountId: 'acc-1',
        discordUserId: '42',
        displayName: 'neo',
        avatarUrl: 'https://cdn.discordapp.com/avatars/42/a.png',
        status: 'awaitingConnector',
        disconnectReason: null,
        boundToThisDevice: true,
      },
      {
        accountId: 'acc-2',
        discordUserId: '43',
        displayName: 'trinity',
        avatarUrl: null,
        status: 'disconnected',
        disconnectReason: 'device-revoked',
        boundToThisDevice: false,
      },
    ]);
  });

  it('treats a missing accounts array as no expected accounts', async () => {
    const http = new MockHttp().on('GET', /\/deviceexpectedaccounts$/, () => json(200, {}));
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    expect(await api.listExpectedAccounts()).toEqual([]);
  });

  it('reports an account removal with only the discordUserId', async () => {
    const http = new MockHttp().on('POST', /\/connectoraccountremovals$/, () =>
      json(200, { removal: { result: 'released', accountId: 'acc-1' } }),
    );
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    expect(await api.removeAccount('42')).toEqual({ result: 'released', accountId: 'acc-1' });
    expect(http.calls[0].url).toBe(`${API_BASE}/connectoraccountremovals`);
    expect(http.calls[0].body).toEqual({ discordUserId: '42' });
    expect(http.calls[0].headers?.['x-device-credential']).toBe(DEVICE.deviceCredential);
  });

  it('revokes itself with PATCH /connectorselfrevoke', async () => {
    const http = new MockHttp().on('PATCH', /\/connectorselfrevoke$/, () => json(200, { id: 'dev-1', revoked: true }));
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    expect(await api.revokeSelf()).toEqual({ id: 'dev-1', revoked: true });
    expect(http.calls[0].body).toBeUndefined();
    expect(http.calls[0].headers?.['x-device-id']).toBe(DEVICE.deviceId);
  });

  it('maps a self-revoke 401 to DeviceRevokedError and a 404 to ConnectorApiError', async () => {
    const http = new MockHttp().on('PATCH', /\/connectorselfrevoke$/, () => problem(401, 'errMsg_DeviceCredentialInvalid'));
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    await expect(api.revokeSelf()).rejects.toBeInstanceOf(DeviceRevokedError);
    http.on('PATCH', /\/connectorselfrevoke$/, () => json(404, { status: 404 }));
    await expect(api.revokeSelf()).rejects.toBeInstanceOf(ConnectorApiError);
  });

  it('answers a guild-channel request as unavailable without guilds', async () => {
    const http = new MockHttp().on('PATCH', /\/guildchannels$/, () => json(200, {}));
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    await api.reportGuildChannelsUnavailable('g1', 'tokenMissing');
    await api.reportGuildChannelsUnavailable('g2', 'discordUnavailable');
    expect(http.calls[0].url).toBe(`${API_BASE}/devicerequests/g1/guildchannels`);
    expect(http.calls[0].body).toEqual({ unavailableReason: 'tokenMissing' });
    expect(http.calls[1].body).toEqual({ unavailableReason: 'discordUnavailable' });
  });

  it('sends tokenMissing only on a failed result', async () => {
    const http = new MockHttp().on('PATCH', /\/sendresult$/, () => json(200, {}));
    const api = new ConnectorApi(API_BASE, http.client, () => DEVICE);
    await api.reportSendResult('r1', { outcome: 'failed', reason: 'Bağlayıcıda bu hesabın tokeni yok', tokenRejected: false, tokenMissing: true });
    await api.reportSendResult('r2', { outcome: 'sent', tokenRejected: false, tokenMissing: true });
    expect(http.calls[0].body).toEqual({
      outcome: 'failed',
      reason: 'Bağlayıcıda bu hesabın tokeni yok',
      tokenRejected: false,
      tokenMissing: true,
    });
    expect(http.calls[1].body).toEqual({ outcome: 'sent', tokenRejected: false });
  });
});
