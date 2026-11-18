import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceAgent, PAUSED_REASON, type AgentStatus } from '../src/core/agent';
import { NetworkError } from '../src/core/http';
import { RequestJournal, type JournalEntry } from '../src/core/journal';
import { DISCORD_BASE, MemoryStore, MockHttp, TOKEN, account, json, makeClients, problem } from './helpers';

const HB = /\/connectorheartbeat$/;
const PENDING = /\/devicerequests\/pending$/;
const SENDRESULT = /\/devicerequests\/([^/]+)\/sendresult$/;
const GUILDRESULT = /\/devicerequests\/([^/]+)\/guildchannels$/;
const DISCORD_SEND = /discord\.test\/api\/v10\/channels\/(\d+)\/messages$/;

function handOff(id: string, discordUserId = '111', channel = '999', text = 'merhaba') {
  return {
    id,
    kind: 'handOff' as const,
    sendRecordId: `sr-${id}`,
    accountId: 'acc-1',
    payload: { discordUserId, discordChannelId: channel, text },
    createdAt: new Date().toISOString(),
  };
}

function setup(opts: { pending?: () => unknown[]; paused?: boolean; journal?: RequestJournal } = {}) {
  const http = new MockHttp();
  let pending = opts.pending ?? (() => []);
  http
    .on('PATCH', HB, () => json(200, { id: 'dev-1', online: true }))
    .on('GET', PENDING, () => json(200, { data: pending(), paging: { page: 1 } }))
    .on('PATCH', SENDRESULT, () => json(200, { id: 'x', status: 'answered' }))
    .on('PATCH', GUILDRESULT, () => json(200, { id: 'x', status: 'answered' }))
    .on('POST', DISCORD_SEND, () => json(200, { id: 'm1' }));
  const { api, discord } = makeClients(http);
  const store = new MemoryStore();
  const statuses: AgentStatus[] = [];
  const revoked = vi.fn();
  const agent = new DeviceAgent({
    api,
    discord,
    store,
    journal: opts.journal,
    isPaused: () => !!opts.paused,
    hooks: { onStatus: (s) => statuses.push(s), onRevoked: revoked },
  });
  return {
    http,
    store,
    agent,
    statuses,
    revoked,
    setPending: (fn: () => unknown[]) => {
      pending = fn;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cadence', () => {
  it('heartbeats every 30 s and polls every 3 s', async () => {
    const { http, agent } = setup();
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.status).toBe('online');
    expect(http.callsTo('PATCH', HB)).toHaveLength(1);
    expect(http.callsTo('GET', PENDING)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(http.callsTo('GET', PENDING)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(27_000);
    expect(http.callsTo('PATCH', HB)).toHaveLength(2);
    expect(http.callsTo('GET', PENDING)).toHaveLength(11);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(http.callsTo('PATCH', HB)).toHaveLength(3);
    expect(http.callsTo('GET', PENDING)).toHaveLength(21);
    agent.stop();
  });

  it('stops all calls on stop()', async () => {
    const { http, agent } = setup();
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    agent.stop();
    const n = http.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(http.calls.length).toBe(n);
    expect(agent.status).toBe('stopped');
  });
});

describe('connectivity', () => {
  it('goes offline on network loss, backs off exponentially and recovers by itself', async () => {
    const { http, agent, statuses } = setup();
    let down = true;
    http.on('PATCH', HB, () => (down ? new NetworkError('ENOTFOUND', false) : json(200, {})));
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.status).toBe('offline');
    expect(http.callsTo('PATCH', HB)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000); // 1st back-off: 2 s
    expect(http.callsTo('PATCH', HB)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_999); // 2nd back-off: 4 s
    expect(http.callsTo('PATCH', HB)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(http.callsTo('PATCH', HB)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(8_000); // 3rd: 8 s
    expect(http.callsTo('PATCH', HB)).toHaveLength(4);
    expect(http.callsTo('GET', /pending/)).toHaveLength(0);

    down = false;
    await vi.advanceTimersByTimeAsync(16_000); // 4th: 16 s, succeeds
    await vi.advanceTimersByTimeAsync(100); // the catch-up poll runs at once, not after 3 s
    expect(agent.status).toBe('online');
    expect(http.callsTo('GET', /pending/)).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'offline', 'online']);
    agent.stop();
  });

  it('caps the back-off at 60 s', async () => {
    const { http, agent } = setup();
    http.on('PATCH', HB, () => new NetworkError('ECONNREFUSED', false));
    agent.start();
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000 + 32_000);
    const n = http.callsTo('PATCH', HB).length;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(http.callsTo('PATCH', HB).length).toBe(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(http.callsTo('PATCH', HB).length).toBe(n + 1);
    agent.stop();
  });

  it('treats a 5xx like a connectivity loss', async () => {
    const { http, agent } = setup();
    http.on('GET', PENDING, () => json(503, { status: 503, detail: 'down' }));
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.status).toBe('offline');
    agent.stop();
  });
});

describe('revocation', () => {
  it('stops and raises onRevoked on 401 errMsg_DeviceCredentialInvalid', async () => {
    const { http, agent, revoked } = setup();
    http.on('GET', PENDING, () => problem(401, 'errMsg_DeviceCredentialInvalid', 'Device credential invalid.'));
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.status).toBe('revoked');
    expect(revoked).toHaveBeenCalledTimes(1);
    const n = http.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(http.calls.length).toBe(n);
  });

  it('revokes when the heartbeat is refused', async () => {
    const { http, agent, revoked } = setup();
    http.on('PATCH', HB, () => problem(401, 'errMsg_DeviceCredentialInvalid'));
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.status).toBe('revoked');
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(http.callsTo('GET', PENDING)).toHaveLength(0);
  });

  it('does not treat a 401 without the device error code as revocation', async () => {
    const { http, agent, revoked } = setup();
    http.on('GET', PENDING, () => json(401, { status: 401, detail: 'something else' }));
    agent.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(revoked).not.toHaveBeenCalled();
    expect(agent.status).toBe('online');
    agent.stop();
  });
});

describe('hand-off', () => {
  it('sends through Discord and reports `sent`', async () => {
    const { http, agent, store } = setup({ pending: () => [handOff('r1')] });
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(0);

    const send = http.callsTo('POST', DISCORD_SEND);
    expect(send).toHaveLength(1);
    expect(send[0].url).toBe(`${DISCORD_BASE}/channels/999/messages`);
    expect(send[0].body).toEqual({ content: 'merhaba' });
    expect(send[0].headers?.Authorization).toBe(TOKEN);
    expect(Object.keys(send[0].headers ?? {}).sort()).toEqual(['Accept', 'Authorization', 'User-Agent']);

    const report = http.callsTo('PATCH', SENDRESULT);
    expect(report).toHaveLength(1);
    expect(report[0].url).toMatch(/\/devicerequests\/r1\/sendresult$/);
    expect(report[0].body).toEqual({ outcome: 'sent', tokenRejected: false });
    // The token never goes to the platform.
    for (const c of http.calls.filter((c) => c.url.includes('connector.test'))) {
      expect(JSON.stringify(c)).not.toContain(TOKEN);
    }
    expect(store.accounts.get('111')?.lastResults[0]).toMatchObject({ outcome: 'sent', discordChannelId: '999' });
    agent.stop();
  });

  it('reports `failed` with the platform-style reason and the Discord code', async () => {
    const { http, agent, store } = setup({ pending: () => [handOff('r2')] });
    http.on('POST', DISCORD_SEND, () => json(403, { message: 'Missing Permissions', code: 50013 }));
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    const report = http.callsTo('PATCH', SENDRESULT);
    expect(report).toHaveLength(1);
    expect(report[0].body).toEqual({
      outcome: 'failed',
      reason: 'İzin yok (Discord 403 · 50013 · Missing Permissions)',
      tokenRejected: false,
    });
    agent.stop();
  });

  it('flags tokenRejected on a Discord 401 and marks the account', async () => {
    const { http, agent, store } = setup({ pending: () => [handOff('r3')] });
    http.on('POST', DISCORD_SEND, () => json(401, { message: '401: Unauthorized', code: 0 }));
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.callsTo('PATCH', SENDRESULT)[0].body).toEqual({
      outcome: 'failed',
      reason: 'Discord tokeni reddetti (Discord 401 · 401: Unauthorized)',
      tokenRejected: true,
    });
    expect(store.accounts.get('111')?.status).toBe('tokenRejected');
    agent.stop();
  });

  it('reports `failed` without calling Discord when the account is not held here', async () => {
    const { http, agent } = setup({ pending: () => [handOff('r4', '222')] });
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.callsTo('POST', DISCORD_SEND)).toHaveLength(0);
    expect(http.callsTo('PATCH', SENDRESULT)[0].body).toEqual({
      outcome: 'failed',
      reason: 'Hesabın tokeni yok',
      tokenRejected: false,
    });
    agent.stop();
  });

  it('answers `failed` without sending while paused', async () => {
    const { http, agent, store } = setup({ pending: () => [handOff('r5')], paused: true });
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.callsTo('POST', DISCORD_SEND)).toHaveLength(0);
    expect(http.callsTo('PATCH', SENDRESULT)[0].body).toEqual({ outcome: 'failed', reason: PAUSED_REASON, tokenRejected: false });
    agent.stop();
  });

  it('treats a 409 on the result as done', async () => {
    const { http, agent, store } = setup({ pending: () => [handOff('r6')] });
    http.on('PATCH', SENDRESULT, () => problem(409, 'errMsg_ResultAlreadyRecordedOrLate'));
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.callsTo('PATCH', SENDRESULT)).toHaveLength(1);
    expect(agent.journal.unreported()).toHaveLength(0);
    agent.stop();
  });

  it('retries a result report through a connectivity loss without re-sending', async () => {
    const { http, agent, store } = setup({ pending: () => [handOff('r7')] });
    let down = true;
    http.on('PATCH', SENDRESULT, () => (down ? new NetworkError('ECONNRESET', false) : json(200, {})));
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.callsTo('PATCH', SENDRESULT)).toHaveLength(1);
    down = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(http.callsTo('PATCH', SENDRESULT)).toHaveLength(2);
    expect(http.callsTo('POST', DISCORD_SEND)).toHaveLength(1);
    expect(agent.journal.unreported()).toHaveLength(0);
    agent.stop();
  });
});

describe('de-duplication', () => {
  it('handles a request listed again only once', async () => {
    const { http, agent, store } = setup({ pending: () => [handOff('dup'), handOff('dup')] });
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(9_000); // four polls listing the same id
    expect(http.callsTo('GET', PENDING).length).toBeGreaterThanOrEqual(4);
    expect(http.callsTo('POST', DISCORD_SEND)).toHaveLength(1);
    expect(http.callsTo('PATCH', SENDRESULT)).toHaveLength(1);
    agent.stop();
  });

  it('never re-sends a hand-off started before a restart (persisted journal)', async () => {
    let saved: JournalEntry[] = [];
    const persistence = { read: () => saved, write: (e: JournalEntry[]) => (saved = JSON.parse(JSON.stringify(e))) };
    const first = setup({ pending: () => [handOff('r8')], journal: new RequestJournal(persistence) });
    await first.store.save(account('111'), TOKEN);
    first.agent.start();
    await vi.advanceTimersByTimeAsync(0);
    first.agent.stop();
    expect(first.http.callsTo('POST', DISCORD_SEND)).toHaveLength(1);

    const second = setup({ pending: () => [handOff('r8')], journal: new RequestJournal(persistence) });
    await second.store.save(account('111'), TOKEN);
    second.agent.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(second.http.callsTo('POST', DISCORD_SEND)).toHaveLength(0);
    second.agent.stop();
  });

  it('re-reports a finished but unreported result after a restart', async () => {
    let saved: JournalEntry[] = [
      { id: 'r9', kind: 'handOff', startedAt: Date.now(), result: { outcome: 'sent', reason: null, tokenRejected: false }, reported: false },
    ];
    const persistence = { read: () => saved, write: (e: JournalEntry[]) => (saved = e) };
    const { http, agent } = setup({ journal: new RequestJournal(persistence) });
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    const report = http.callsTo('PATCH', SENDRESULT);
    expect(report).toHaveLength(1);
    expect(report[0].url).toMatch(/\/r9\/sendresult$/);
    expect(saved[0].reported).toBe(true);
    agent.stop();
  });
});

describe('guild channels', () => {
  const GUILDS = /discord\.test\/api\/v10\/users\/@me\/guilds$/;
  const CHANNELS = /discord\.test\/api\/v10\/guilds\/(\d+)\/channels$/;
  const request = { id: 'g1', kind: 'guildChannels', accountId: 'acc-1', payload: { discordUserId: '111' } };

  it('lists text channels and answers within the budget', async () => {
    const { http, agent, store } = setup({ pending: () => [request] });
    http
      .on('GET', GUILDS, () => json(200, [{ id: '1', name: 'Beta' }, { id: '2', name: 'Alfa' }]))
      .on('GET', CHANNELS, (req) =>
        req.url.includes('/guilds/1/')
          ? json(200, [
              { id: '11', name: 'genel', type: 0, position: 2 },
              { id: '12', name: 'ses', type: 2, position: 0 },
              { id: '13', name: 'duyuru', type: 5, position: 1 },
            ])
          : json(403, { message: 'Missing Access', code: 50001 }),
      );
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    const answer = http.callsTo('PATCH', GUILDRESULT);
    expect(answer).toHaveLength(1);
    expect(answer[0].url).toMatch(/\/devicerequests\/g1\/guildchannels$/);
    expect(answer[0].body).toEqual({
      guilds: [
        {
          guildId: '1',
          guildName: 'Beta',
          channels: [
            { channelId: '13', discordChannelId: '13', channelName: 'duyuru' },
            { channelId: '11', discordChannelId: '11', channelName: 'genel' },
          ],
        },
      ],
      tokenRejected: false,
    });
    agent.stop();
  });

  it('answers tokenRejected with no guilds when Discord rejects the token', async () => {
    const { http, agent, store } = setup({ pending: () => [request] });
    http.on('GET', GUILDS, () => json(401, { message: '401: Unauthorized', code: 0 }));
    await store.save(account('111'), TOKEN);
    agent.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.callsTo('PATCH', GUILDRESULT)[0].body).toEqual({ guilds: [], tokenRejected: true });
    expect(store.accounts.get('111')?.status).toBe('tokenRejected');
    agent.stop();
  });

  it('does not answer for an account it does not hold', async () => {
    const { http, agent } = setup({ pending: () => [request] });
    agent.start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(http.callsTo('PATCH', GUILDRESULT)).toHaveLength(0);
    agent.stop();
  });
});
