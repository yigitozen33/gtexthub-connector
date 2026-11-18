import { describe, expect, it } from 'vitest';
import { DiscordClient, PLATFORM_USER_AGENT, fail } from '../src/core/discord';
import { NetworkError } from '../src/core/http';
import { DISCORD_BASE, MockHttp, TOKEN, json } from './helpers';

describe('failure mapping (port of discordRequest.js fail())', () => {
  it('formats reasons like the platform', () => {
    expect(fail('notFound', { status: 404, discordCode: 10003, detail: 'Unknown Channel' }).detailedReason).toBe(
      'Kanal bulunamadı (Discord 404 · 10003 · Unknown Channel)',
    );
    expect(fail('rateLimited', { status: 429 }).detailedReason).toBe('Discord hız sınırı (Discord 429)');
    expect(fail('discordError', { status: 500 }).reason).toBe('Discord hatası (HTTP 500)');
    expect(fail('discordError', { networkError: 'ECONNREFUSED' }).detailedReason).toBe(
      "Discord'a ulaşılamadı (ağ hatası: ECONNREFUSED)",
    );
    expect(fail('noToken').detailedReason).toBe('Hesabın tokeni yok');
  });

  it('caps the appended detail at 120 characters', () => {
    const r = fail('forbidden', { status: 403, discordCode: 50013, detail: 'x'.repeat(300) });
    const inner = r.detailedReason!.slice('İzin yok ('.length, -1);
    expect(inner.length).toBe(120);
    expect(inner.endsWith('…')).toBe(true);
  });
});

describe('DiscordClient', () => {
  it('validates a token with GET /users/@me and builds the avatar URL', async () => {
    const http = new MockHttp().on('GET', /\/users\/@me$/, () =>
      json(200, { id: '42', username: 'neo', global_name: 'Neo', avatar: 'a_abc' }),
    );
    const d = new DiscordClient(http.client, DISCORD_BASE);
    const r = await d.validateToken(TOKEN);
    expect(r).toEqual({
      ok: true,
      user: { discordUserId: '42', displayName: 'Neo', avatarUrl: 'https://cdn.discordapp.com/avatars/42/a_abc.gif' },
    });
    expect(http.calls[0].headers).toEqual({ Authorization: TOKEN, Accept: 'application/json', 'User-Agent': PLATFORM_USER_AGENT });
    expect(http.calls[0].timeoutMs).toBe(15_000);
  });

  it('scrubs the token out of a Discord message', async () => {
    const http = new MockHttp().on('POST', /messages$/, () => json(400, { message: `bad ${TOKEN} here`, code: 50035 }));
    const d = new DiscordClient(http.client, DISCORD_BASE);
    const r = await d.sendMessage(TOKEN, '123', 'hi');
    expect(r.detail).toBe('bad *** here');
    expect(r.detailedReason).not.toContain(TOKEN);
  });

  it('maps a timeout like the platform', async () => {
    const http = new MockHttp().on('POST', /messages$/, () => new NetworkError('TIMEOUT', true));
    const d = new DiscordClient(http.client, DISCORD_BASE);
    const r = await d.sendMessage(TOKEN, '123', 'hi');
    expect(r.failure).toBe('discordError');
    expect(r.detailedReason).toBe("Discord'a ulaşılamadı (ağ hatası: zaman aşımı)");
  });

  it('refuses a malformed channel id without calling Discord', async () => {
    const http = new MockHttp();
    const d = new DiscordClient(http.client, DISCORD_BASE);
    const r = await d.sendMessage(TOKEN, '../users/@me', 'hi');
    expect(r.failure).toBe('notFound');
    expect(http.calls).toHaveLength(0);
  });

  it('honours retry_after: no Discord call during the cool-down', async () => {
    let now = 1_000_000;
    const http = new MockHttp().on('POST', /messages$/, () =>
      json(429, { message: 'You are being rate limited.', retry_after: 2.5, global: false }),
    );
    const d = new DiscordClient(http.client, DISCORD_BASE, () => now);
    const first = await d.sendMessage(TOKEN, '1', 'a');
    expect(first.failure).toBe('rateLimited');
    expect(first.detailedReason).toBe('Discord hız sınırı (Discord 429 · You are being rate limited.)');

    now += 2_000;
    const second = await d.sendMessage(TOKEN, '1', 'a');
    expect(second.failure).toBe('rateLimited');
    expect(http.calls).toHaveLength(1);

    now += 600;
    http.on('POST', /messages$/, () => json(200, { id: 'm' }));
    const third = await d.sendMessage(TOKEN, '1', 'a');
    expect(third.failure).toBeNull();
    expect(http.calls).toHaveLength(2);
  });
});
