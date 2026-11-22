import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { createBotGuard } from '../../middleware/bot-guard.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { botsRouter } from '../../routes/bots.js';
import { resetQueue } from '../../services/bot-queue.js';
import { forgetQuota } from '../../services/bot-keys.js';
import { mintDashboardToken } from '../helpers/auth.js';

describe('bot keys: admin API and inference admission', () => {
  let server: Server;
  let url: string;
  let token: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM bot_keys').run();
    resetQueue();
    token = mintDashboardToken();
    const app = express();
    app.use(express.json());
    app.use('/api/bots', requireAuth, botsRouter);
    // A stand-in for the inference routers: the guard is the thing under test.
    app.use('/v1', createBotGuard());
    app.post('/v1/chat/completions', (_req, res) => {
      res.json({ id: 'chatcmpl-test', object: 'chat.completion', choices: [] });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  async function api(method: string, path: string, body?: unknown, auth = token) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* 204 */ }
    return { status: res.status, json, headers: res.headers };
  }

  it('rejects unauthenticated admin calls', async () => {
    expect((await api('GET', '/api/bots', undefined, '')).status).toBe(401);
  });

  it('creates, lists, updates and deletes a bot through the admin API', async () => {
    const created = await api('POST', '/api/bots', { name: 'telegram', rpmLimit: 50, priority: 9 });
    expect(created.status).toBe(201);
    expect(created.json.key).toMatch(/^sk-bot-/);
    expect(created.json.bot.maskedKey).toContain('...');
    expect(created.json.bot.maskedKey).not.toBe(created.json.key);
    const id = created.json.bot.id;

    const listed = await api('GET', '/api/bots');
    expect(listed.json.bots.some((b: any) => b.id === id)).toBe(true);

    const updated = await api('PATCH', `/api/bots/${id}`, { priority: 3, rpmLimit: 2 });
    expect(updated.json.bot.priority).toBe(3);
    forgetQuota(id);

    const usage = await api('GET', `/api/bots/${id}/usage`);
    expect(usage.json.totals.requests).toBeGreaterThanOrEqual(0);

    expect((await api('DELETE', `/api/bots/${id}`)).status).toBe(204);
    expect((await api('GET', `/api/bots/${id}`)).status).toBe(404);
  });

  it('admits a bot key, returns 401 for an unknown key, and 429 when the quota is spent', async () => {
    const created = await api('POST', '/api/bots', { name: 'quota-bot', rpmLimit: 1, dailyLimit: 1 });
    const key = created.json.key as string;
    const id = created.json.bot.id;

    const call = (k: string) => fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const unknown = await call('sk-bot-not-a-real-key');
    expect(unknown.status).toBe(401);

    const first = await call(key);
    expect(first.status).toBe(200);
    await first.text();

    const second = await call(key);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    await second.text();

    const usage = await api('GET', `/api/bots/${id}/usage`);
    expect(usage.json.totals.requests).toBe(1);
    expect(usage.json.totals.tokens).toBeGreaterThan(0);
  });

  it('blocks a bot from models outside its allow-list', async () => {
    const created = await api('POST', '/api/bots', { name: 'scoped-bot', allowedModels: ['fast'] });
    const key = created.json.key as string;
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'smart', messages: [] }),
    });
    expect(res.status).toBe(403);
    await res.text();
  });
});
