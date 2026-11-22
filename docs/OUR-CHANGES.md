# Our changes on top of the original FreeLLMAPI

The ledger of what `distorx/integration` adds to `tashfeenahmed/freellmapi`. Every update
from the original is checked against this list (skill `preserve-our-changes`). Run a proof
from `server/` with `npx vitest run --pool=forks <file>`.

| Change | Why | Where | Proof | Off switch |
|---|---|---|---|---|
| Stall failover | An attempt with no output is abandoned and the next route is tried; covers the time before a stream opens and non-streaming requests | `server/src/lib/fallback-loop.ts` (`getAttemptStallTimeoutMs`, stall timer, `renewInFlightAbort`), `server/src/routes/proxy.ts` (`noteFirstByte`) | `src/__tests__/lib/fallback-loop-stall.test.ts` | settings `attempt_stall_timeout_ms`, `attempt_stall_timeout_nonstream_ms` (0 = off, the default) |
| Paid-plan flag on a key | A subscription key's own model list is discovered and used; the catalog lists free models only | `server/src/routes/keys.ts`, `services/builtin-model-discovery.ts`, `services/catalog-sync.ts`, migration `20261120_000001_key_paid_plan.ts`, `client/.../edit-key-dialog.tsx` | `routes/keys-paid-plan.test.ts`, `services/builtin-model-discovery.test.ts`, `services/catalog-sync.test.ts` | the switch on the key (off by default) |
| Ollama balance and reserve | Reads Ollama Cloud's balance, lowers the score as it runs out, and keeps a reserved share unused | `providers/ollama-balance.ts`, `services/provider-quota.ts`, `services/scoring.ts`, `services/router.ts` | `services/ollama-balance-guard.test.ts` | setting `quota_reserve_percent_<platform>` (0 = off) |
| Balance re-read while in use | A key being spent is polled at most once a minute, so the reserve engages in time | `services/provider-quota.ts`, `services/health.ts` | `services/ollama-balance-guard.test.ts` | env `QUOTA_POLL_IN_USE_INTERVAL_MS` (0 = off) |
| Retired models are unavailable | A model retired by the original stops resolving by name; `/v1/models` says `retired` | `services/model-state.ts`, `services/model-listing.ts` | `services/model-retirement.test.ts` | none |
| Ollama decision model | Ollama models can serve as the routing decision model | `services/decision.ts`, `providers/index.ts` | `services/decision.test.ts` | chosen in settings |

## Update log

### 2026-11-22: 18 commits from the original (up to `ef97f50`)
- Conflicts in three files, each decided by hand; all six changes preserved, one adapted.
- **Stall failover, adapted.** The original added its own per-attempt silent-window cap
  (#1960: setting `fallback_attempt_silent_ms`, default 60 s, streaming only, armed when the
  upstream stream opens). Both now run side by side. Ours still covers what theirs does
  not: the time before a stream opens, adapters that fake a stream, and non-streaming
  requests. The original's `abortInFlight` now renews the abort controller itself, so our
  `renewInFlightAbort` hook only marks the surface that opts in to our timeout.
- Paid-plan discovery: kept our gates, took the original's new `specialistTask(id, platform)` call.
- Proof: full server suite 5,689 passed, 6 skipped; the seven proof files above 137 passed.
