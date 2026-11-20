// Migration: paid_plan flag on api_keys
// Created: 2026-11-20
//
// DOWN: reversible (DROP COLUMN)
//
// The signed catalog lists a provider's FREE models only. A key that belongs
// to a paid subscription (Ollama Cloud Pro, for one) can serve many more, but
// the router had no rows for them, so the subscription sat unused. paid_plan
// is the operator saying "this key is on a paid plan": the platform's models
// are then read from the provider's own /models list (see
// services/builtin-model-discovery.ts) and survive catalog syncs.
//
// 0 for every existing key, so nothing changes until an operator sets it.
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'paid_plan')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN paid_plan INTEGER NOT NULL DEFAULT 0').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'api_keys', 'paid_plan')) {
    db.prepare('ALTER TABLE api_keys DROP COLUMN paid_plan').run();
  }
}
