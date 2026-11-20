// Ollama Cloud balance (GET https://ollama.com/api/balance) → a quota reading.
//
// Subscriptions on Ollama's session/weekly terms report two allowances, each
// as a percentage of a window that resets on its own clock:
//
//   { "included": { "session": { "remaining_percent": 99.44, "resets_at": "…" },
//                   "weekly":  { "remaining_percent": 79.76, "resets_at": "…" } },
//     "purchased": { "balance_usd": 0 } }
//
// Whichever allowance is lower is the one that will refuse requests first, so
// the reading reports that one: limit 100, remaining = its percentage, and its
// own reset time. A key on these terms cannot be metered in tokens or
// requests at all (the allowance is GPU time), which is why local counters
// never knew how close it was.
//
// Anything else — a plan that reports credits instead of windows, a shape this
// file has not seen — yields null: no observation, and routing keeps its
// "unknown" default rather than acting on a guess.

export interface OllamaBalanceReading {
  limit: number;
  remaining: number;
  resetAt: string | null;
  notes: string;
}

interface Allowance { percent: number; resetsAt: string | null }

function allowance(raw: unknown): Allowance | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { remaining_percent?: unknown; resets_at?: unknown };
  if (typeof o.remaining_percent !== 'number' || !Number.isFinite(o.remaining_percent)) return null;
  const resetsAt = typeof o.resets_at === 'string' && Number.isFinite(Date.parse(o.resets_at)) ? o.resets_at : null;
  return { percent: Math.max(0, Math.min(100, o.remaining_percent)), resetsAt };
}

export function parseOllamaBalance(body: unknown): OllamaBalanceReading | null {
  if (!body || typeof body !== 'object') return null;
  const included = (body as { included?: unknown }).included;
  if (!included || typeof included !== 'object') return null;
  const windows: Array<[string, Allowance]> = [];
  for (const name of ['session', 'weekly'] as const) {
    const a = allowance((included as Record<string, unknown>)[name]);
    if (a) windows.push([name, a]);
  }
  if (windows.length === 0) return null;
  const [bindingName, binding] = windows.reduce((low, w) => (w[1].percent < low[1].percent ? w : low));
  return {
    limit: 100,
    remaining: binding.percent,
    resetAt: binding.resetsAt,
    notes: `ollama balance, percent of the ${bindingName} allowance left (`
      + windows.map(([n, a]) => `${n} ${a.percent}%`).join(', ') + ')',
  };
}
