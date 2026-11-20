import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// The paid-plan flag on a key: stored through PATCH /api/keys/:id and reported
// by GET /api/keys. What the flag does to model discovery is covered in
// services/builtin-model-discovery.test.ts; discovery is switched off here so
// setting the flag cannot start a real /models request.

let dashToken = '';
const ORIGINAL_MODE = process.env.BUILTIN_MODEL_DISCOVERY;

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('PATCH /api/keys/:id paidPlan', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.BUILTIN_MODEL_DISCOVERY = 'off';
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterAll(() => {
    if (ORIGINAL_MODE === undefined) delete process.env.BUILTIN_MODEL_DISCOVERY;
    else process.env.BUILTIN_MODEL_DISCOVERY = ORIGINAL_MODE;
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('is false for a new key, and can be set and cleared on its own', async () => {
    const created = await request(app, 'POST', '/api/keys', { platform: 'ollama', key: 'ollama_paid_plan_test_key_1' });
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    const listed = async () => (await request(app, 'GET', '/api/keys')).body.find((k: { id: number }) => k.id === id);
    expect((await listed()).paidPlan).toBe(false);

    const on = await request(app, 'PATCH', `/api/keys/${id}`, { paidPlan: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ success: true, paidPlan: true });
    expect((await listed()).paidPlan).toBe(true);

    const off = await request(app, 'PATCH', `/api/keys/${id}`, { paidPlan: false });
    expect(off.body).toMatchObject({ success: true, paidPlan: false });
    expect((await listed()).paidPlan).toBe(false);
  });

  it('rejects a non-boolean value', async () => {
    const created = await request(app, 'POST', '/api/keys', { platform: 'ollama', key: 'ollama_paid_plan_test_key_2' });
    const res = await request(app, 'PATCH', `/api/keys/${created.body.id}`, { paidPlan: 'yes' });
    expect(res.status).toBe(400);
  });
});
