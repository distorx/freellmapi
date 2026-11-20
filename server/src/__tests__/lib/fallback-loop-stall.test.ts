import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, setSetting } from '../../db/index.js';
import {
  runFallbackLoop, newFallbackState, getAttemptStallTimeoutMs,
  ATTEMPT_STALL_TIMEOUT_SETTING, ATTEMPT_STALL_TIMEOUT_NONSTREAM_SETTING,
  type DispatchContext, type FallbackState,
} from '../../lib/fallback-loop.js';
import { newHedgeAbortError } from '../../lib/error-classify.js';
import { acquireLease, releaseLease, resetLeases } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

/**
 * Stall failover: an attempt that has produced nothing within the stall timeout
 * is abandoned and the ladder moves to the next candidate. Unlike the
 * wall-clock budget hedge it runs on every attempt (the first included) and it
 * does not end the request.
 */

let keySeq = 1900;
function leasedRoute(model = 'fake-model'): RouteResult {
  const keyId = ++keySeq;
  const id = acquireLease('fake', model, keyId, 100);
  return {
    provider: {} as any,
    modelId: model,
    modelDbId: 1900000 + keyId,
    apiKey: 'test-key',
    keyId,
    platform: 'fake',
    displayName: 'Fake Model',
    rpdLimit: null,
    tpdLimit: null,
    release: () => releaseLease(id),
  };
}

/** A surface with a renewable abort signal, the way the chat route keeps one. */
function surface() {
  let controller = new AbortController();
  return {
    abortInFlight: () => controller.abort(newHedgeAbortError()),
    renewInFlightAbort: () => { controller = new AbortController(); },
    signal: () => controller.signal,
  };
}

function hooks(state: FallbackState, overrides: Record<string, unknown>) {
  return {
    state,
    timeBudgetMs: 0,
    logFailure: vi.fn(),
    onFatal: vi.fn(),
    onRoutingExhausted: vi.fn(),
    onExhausted: vi.fn(),
    ...overrides,
  } as any;
}

/** Hangs until the signal it was given aborts, like a fetch with no response. */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('fallback loop stall failover', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetLeases();
    vi.restoreAllMocks();
    delete process.env.ATTEMPT_STALL_TIMEOUT_MS;
  });

  it('is off unless configured; the setting wins over the env var, per mode', () => {
    expect(getAttemptStallTimeoutMs(true)).toBe(0);
    expect(getAttemptStallTimeoutMs(false)).toBe(0);
    process.env.ATTEMPT_STALL_TIMEOUT_MS = '9000';
    expect(getAttemptStallTimeoutMs(true)).toBe(9000);
    expect(getAttemptStallTimeoutMs(false)).toBe(0);
    setSetting(ATTEMPT_STALL_TIMEOUT_SETTING, '4000');
    setSetting(ATTEMPT_STALL_TIMEOUT_NONSTREAM_SETTING, '60000');
    expect(getAttemptStallTimeoutMs(true)).toBe(4000);
    expect(getAttemptStallTimeoutMs(false)).toBe(60000);
  });

  it('abandons a silent FIRST attempt and serves the request from the next route', async () => {
    setSetting(ATTEMPT_STALL_TIMEOUT_SETTING, '40');
    const s = surface();
    const state = newFallbackState();
    const dispatch = vi.fn()
      .mockImplementationOnce(() => hang(s.signal()))
      .mockImplementationOnce(async () => {
        // The renewed signal must be live, or the second attempt dies at once.
        expect(s.signal().aborted).toBe(false);
        return 'done';
      });
    const stalledRoute = leasedRoute('silent-model');
    const route = vi.fn().mockReturnValueOnce(stalledRoute).mockImplementation(() => leasedRoute('good-model'));
    const attemptLog: any[] = [];
    const h = hooks(state, { maxRetries: 5, streaming: true, attemptLog, route, dispatch, ...s });

    const started = Date.now();
    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(h.onFatal).not.toHaveBeenCalled();
    // The stall is a provider failure: logged, and the model is ruled out for
    // the rest of the request so a sibling key does not wait on it again.
    expect(h.logFailure).toHaveBeenCalledTimes(1);
    expect(String(h.logFailure.mock.calls[0][1].message)).toContain('no output within 40ms');
    expect(state.skipModels.has(stalledRoute.modelDbId)).toBe(true);
    expect(attemptLog.map(a => a.errorClass)).toEqual(['timeout']);
  });

  it('leaves an attempt alone once it reports its first byte', async () => {
    setSetting(ATTEMPT_STALL_TIMEOUT_SETTING, '30');
    const s = surface();
    const dispatch = vi.fn(async (_route: RouteResult, _attempt: number, ctx: DispatchContext) => {
      ctx.noteFirstByte();
      await new Promise(r => setTimeout(r, 90)); // slow, but alive
      return 'done' as const;
    });
    const h = hooks(newFallbackState(), { maxRetries: 3, streaming: true, route: () => leasedRoute(), dispatch, ...s });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.logFailure).not.toHaveBeenCalled();
    expect(s.signal().aborted).toBe(false);
  });

  it('uses the non-streaming timeout for a non-streaming request', async () => {
    setSetting(ATTEMPT_STALL_TIMEOUT_SETTING, '20');            // would kill it if misapplied
    setSetting(ATTEMPT_STALL_TIMEOUT_NONSTREAM_SETTING, '0');   // off
    const s = surface();
    const dispatch = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 80));
      return 'done' as const;
    });
    const h = hooks(newFallbackState(), { maxRetries: 3, streaming: false, route: () => leasedRoute(), dispatch, ...s });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.logFailure).not.toHaveBeenCalled();
  });

  it('stays off for a surface that cannot renew its abort signal', async () => {
    setSetting(ATTEMPT_STALL_TIMEOUT_SETTING, '20');
    const s = surface();
    const dispatch = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 80));
      return 'done' as const;
    });
    const h = hooks(newFallbackState(), {
      maxRetries: 3, streaming: true, route: () => leasedRoute(), dispatch,
      abortInFlight: s.abortInFlight, // no renewInFlightAbort
    });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(s.signal().aborted).toBe(false);
  });

  it('renders exhaustion, not a hang, when every route stalls', async () => {
    setSetting(ATTEMPT_STALL_TIMEOUT_SETTING, '25');
    const s = surface();
    const dispatch = vi.fn(() => hang(s.signal()));
    const h = hooks(newFallbackState(), { maxRetries: 2, streaming: true, route: () => leasedRoute(), dispatch, ...s });

    await runFallbackLoop(h);

    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(h.onExhausted.mock.calls.length + h.onRoutingExhausted.mock.calls.length).toBe(1);
  });
});
