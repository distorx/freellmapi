import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { parseOllamaBalance } from '../../providers/ollama-balance.js';
import { getProvider } from '../../providers/index.js';
import {
  getKeyQuotaHeadroom, getPlatformQuotaHeadroom, getQuotaReserveFraction,
  isInsideQuotaReserve, recordQuotaObservation, resetQuotaReserveCache, invalidateKeyQuotaHeadroom,
} from '../../services/provider-quota.js';
import { remainingHeadroomFactor } from '../../services/scoring.js';
import { markKeyHealthyFromRequest, pollQuotaAfterUse, resetQuotaPollAfterUse } from '../../services/health.js';

// An Ollama Cloud subscription on session/weekly terms is metered in GPU time
// and reported only as "percent of the window left". These tests pin the
// reading taken from GET /api/balance and the two things routing does with a
// provider-reported balance: step back as it runs low, and never spend the
// share the operator reserved for the other tools on the same key.

const realFetch = globalThis.fetch;
const BALANCE = {
  included: {
    session: { remaining_percent: 99.44, resets_at: '2099-01-01T17:00:00Z' },
    weekly: { remaining_percent: 79.76, resets_at: '2099-01-04T00:00:00Z' },
  },
  purchased: { balance_usd: 0 },
};

function addKey(platform = 'ollama'): number {
  const { encrypted, iv, authTag } = encrypt('ollama-test-key');
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag).lastInsertRowid);
}

function report(keyId: number, percent: number, resetAt: string | null = '2099-01-01T00:00:00Z'): void {
  recordQuotaObservation({
    platform: 'ollama', keyId, quotaPoolKey: 'ollama::cloud', endpoint: 'quota_api', metric: 'credits',
    limit: 100, remaining: percent, resetAt, resetStrategy: 'provider_reported', source: 'quota_api', statusCode: 200,
  });
}

describe('parseOllamaBalance', () => {
  it('reports the lower of the two allowances, with that window\'s reset time', () => {
    expect(parseOllamaBalance(BALANCE)).toMatchObject({ limit: 100, remaining: 79.76, resetAt: '2099-01-04T00:00:00Z' });
    const sessionLow = { included: { session: { remaining_percent: 3, resets_at: '2099-01-01T17:00:00Z' }, weekly: { remaining_percent: 60, resets_at: '2099-01-04T00:00:00Z' } } };
    const reading = parseOllamaBalance(sessionLow)!;
    expect(reading).toMatchObject({ remaining: 3, resetAt: '2099-01-01T17:00:00Z' });
    expect(reading.notes).toContain('session allowance');
    expect(reading.notes).toContain('weekly 60%');
  });

  it('accepts a single window and clamps an out-of-range percentage', () => {
    expect(parseOllamaBalance({ included: { weekly: { remaining_percent: 140 } } })).toMatchObject({ remaining: 100, resetAt: null });
    expect(parseOllamaBalance({ included: { session: { remaining_percent: -5, resets_at: 'not a date' } } })).toMatchObject({ remaining: 0, resetAt: null });
  });

  it('yields nothing for a shape it does not know, rather than guessing', () => {
    for (const body of [null, 'x', {}, { included: null }, { included: {} }, { included: { monthly: { remaining_usd: 12 } } },
      { included: { session: { remaining_percent: '50' } } }]) {
      expect(parseOllamaBalance(body)).toBeNull();
    }
  });
});

describe('provider-reported balance in routing', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetQuotaReserveCache();
    invalidateKeyQuotaHeadroom();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    delete process.env.QUOTA_RESERVE_PERCENT_OLLAMA;
  });

  it('the Ollama provider polls /api/balance with the key and records the reading', async () => {
    const keyId = addKey();
    const mock = vi.fn(async () => new Response(JSON.stringify(BALANCE), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = mock as any;
    const provider = getProvider('ollama')!;
    expect(provider.hasQuotaProbe).toBe(true);

    expect(await provider.fetchQuota('ollama-test-key', { platform: 'ollama', keyId, quotaPoolKey: 'ollama::cloud' })).toBe(true);

    expect(String(mock.mock.calls[0]![0])).toBe('https://ollama.com/api/balance');
    expect(((mock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer ollama-test-key');
    expect(getKeyQuotaHeadroom('ollama').get(keyId)).toBeCloseTo(0.7976, 4);
    const row = getDb().prepare("SELECT reset_at, notes, source FROM provider_quota_state WHERE platform = 'ollama' AND key_id = ?").get(keyId) as { reset_at: string; notes: string; source: string };
    expect(row.source).toBe('quota_api');
    expect(row.notes).toContain('weekly');
    expect(Date.parse(row.reset_at.includes('T') ? row.reset_at : row.reset_at.replace(' ', 'T') + 'Z')).toBe(Date.parse('2099-01-04T00:00:00Z'));
  });

  it('records nothing when the balance has no window to read', async () => {
    const keyId = addKey();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ included: {} }), { status: 200 })) as any;
    expect(await getProvider('ollama')!.fetchQuota('k', { platform: 'ollama', keyId })).toBe(false);
    expect(getKeyQuotaHeadroom('ollama').size).toBe(0);
  });

  it('platform headroom is the best key, and absent without a reading', () => {
    expect(getPlatformQuotaHeadroom('ollama')).toBeUndefined();
    const a = addKey(); const b = addKey();
    report(a, 4); report(b, 55);
    invalidateKeyQuotaHeadroom();
    expect(getPlatformQuotaHeadroom('ollama')).toBeCloseTo(0.55, 5);
  });

  it('treats a window that has already reset as full again', () => {
    const keyId = addKey();
    report(keyId, 2, '2000-01-01T00:00:00Z');
    invalidateKeyQuotaHeadroom();
    expect(getKeyQuotaHeadroom('ollama').get(keyId)).toBe(1);
  });

  it('the score factor is 1 while comfortable or unknown, and ramps to the floor as it empties', () => {
    expect(remainingHeadroomFactor(undefined)).toBe(1);
    expect(remainingHeadroomFactor(0.8)).toBe(1);
    expect(remainingHeadroomFactor(0.1)).toBeGreaterThan(remainingHeadroomFactor(0.02));
    expect(remainingHeadroomFactor(0.1)).toBeLessThan(1);
    expect(remainingHeadroomFactor(0)).toBeCloseTo(0.1, 5);
  });

  it('holds a key back once its reported headroom is inside the reserve', () => {
    const keyId = addKey();
    report(keyId, 30);
    expect(isInsideQuotaReserve('ollama', keyId)).toBe(false); // reserve off by default

    setSetting('quota_reserve_percent_ollama', '25');
    resetQuotaReserveCache();
    expect(getQuotaReserveFraction('ollama')).toBe(0.25);
    expect(isInsideQuotaReserve('ollama', keyId)).toBe(false); // 30% left > 25% reserve

    report(keyId, 25);
    invalidateKeyQuotaHeadroom();
    expect(isInsideQuotaReserve('ollama', keyId)).toBe(true);

    // A key the provider has said nothing about is unknown, never "empty".
    expect(isInsideQuotaReserve('ollama', addKey())).toBe(false);
  });

  it('reads the reserve from the env var when no setting exists, and ignores nonsense', () => {
    process.env.QUOTA_RESERVE_PERCENT_OLLAMA = '40';
    resetQuotaReserveCache();
    expect(getQuotaReserveFraction('ollama')).toBe(0.4);
    process.env.QUOTA_RESERVE_PERCENT_OLLAMA = '250';
    resetQuotaReserveCache();
    expect(getQuotaReserveFraction('ollama')).toBe(0);
  });

  describe('re-reading the balance while it is being spent', () => {
    const balanceAt = (percent: number) => vi.fn(async () => new Response(
      JSON.stringify({ included: { weekly: { remaining_percent: percent, resets_at: '2099-01-04T00:00:00Z' } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    beforeEach(() => resetQuotaPollAfterUse());
    afterEach(() => { delete process.env.QUOTA_POLL_IN_USE_INTERVAL_MS; });

    it('polls on a served request, then at most once per interval for that key', async () => {
      const keyId = addKey();
      const mock = balanceAt(40);
      globalThis.fetch = mock as any;

      expect(await pollQuotaAfterUse(keyId, 1_000_000)).toBe(true);
      invalidateKeyQuotaHeadroom();
      expect(getKeyQuotaHeadroom('ollama').get(keyId)).toBeCloseTo(0.4, 5);

      expect(pollQuotaAfterUse(keyId, 1_000_000 + 30_000)).toBeNull();   // inside the minute
      expect(await pollQuotaAfterUse(keyId, 1_000_000 + 61_000)).toBe(true);
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('is started by the same hook a successful request already calls', async () => {
      const keyId = addKey();
      const mock = balanceAt(12);
      globalThis.fetch = mock as any;
      markKeyHealthyFromRequest(keyId);
      await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    });

    it('remembers a key whose provider has no balance endpoint, and can be switched off', async () => {
      const groq = addKey('groq');
      const mock = balanceAt(50);
      globalThis.fetch = mock as any;
      expect(await pollQuotaAfterUse(groq, 1_000)).toBe(false);
      expect(pollQuotaAfterUse(groq, 10_000_000)).toBeNull();
      expect(mock).not.toHaveBeenCalled();

      process.env.QUOTA_POLL_IN_USE_INTERVAL_MS = '0';
      expect(pollQuotaAfterUse(addKey(), 1_000)).toBeNull();
    });
  });
});
