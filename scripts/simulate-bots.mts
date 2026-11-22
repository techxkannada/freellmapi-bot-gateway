// Fault-injection simulation: 6 bots hammer one gateway while two of the three
// provider keys are forced to return 429 and 500. Run with:
//
//   npx tsx scripts/simulate-bots.ts
//
// Everything runs in-process against the real routers, real bot guard, real
// key health/cooldown machinery and real failover loop. Only the upstream
// HTTP response is stubbed (global fetch), so the simulation needs no provider
// credentials and never calls a real LLM API.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? '0'.repeat(64);
process.env.PROXY_RATE_LIMIT_RPM = '1000000';
process.env.ADMIN_RATE_LIMIT_RPM = '1000000';
process.env.TUNNEL_AUTOSTART = '0';

const { initDb, getDb } = await import('../server/src/db/index.js');
const { createApp } = await import('../server/src/app.js');
const { encrypt } = await import('../server/src/lib/crypto.js');
const { createBot } = await import('../server/src/services/bot-keys.js');
const { getMetricsSnapshot, resetMetrics } = await import('../server/src/services/metrics.js');
const {
  findBinary, startTunnel, stopTunnel, waitForTunnelUrl, getTunnelStatus,
} = await import('../server/src/services/tunnel.js');
const { queueStats } = await import('../server/src/services/bot-queue.js');

initDb(':memory:');
resetMetrics();
const db = getDb();

// ── One model, three keys: two broken, one healthy ───────────────────────────
const MODEL_ID = 'openai/gpt-oss-20b';
const model = db.prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = ?").get(MODEL_ID) as { id: number };
if (!model) throw new Error(`fixture model ${MODEL_ID} missing`);
db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(model.id);
db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(model.id);

const KEY_429 = 'sim-groq-key-429';
const KEY_500 = 'sim-groq-key-500';
const KEY_OK = 'sim-groq-key-ok';
for (const key of [KEY_429, KEY_500, KEY_OK]) {
  const secret = encrypt(key);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
    VALUES ('groq', ?, ?, ?, ?, 'healthy', 1, NULL)
  `).run(key, secret.encrypted, secret.iv, secret.authTag);
}

// ── Stub only the upstream call ──────────────────────────────────────────────
const originalFetch = globalThis.fetch;
let observed429 = 0;
let observed500 = 0;
let observed200 = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (!url.includes('api.groq.com')) return originalFetch(input, init);

  const headers = init?.headers as Record<string, string> | undefined;
  const auth = headers?.Authorization ?? headers?.authorization ?? '';
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  if (auth.includes(KEY_429)) {
    observed429++;
    return json({ error: { message: 'Rate limit reached', type: 'rate_limit_error' } }, 429);
  }
  if (auth.includes(KEY_500)) {
    observed500++;
    return json({ error: { message: 'Upstream exploded', type: 'server_error' } }, 500);
  }
  if (auth.includes(KEY_OK)) {
    observed200++;
    return json({
      id: 'chatcmpl-sim', object: 'chat.completion', created: 0, model: MODEL_ID,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }, 200);
  }
  return json({ error: { message: 'unknown simulated key' } }, 401);
}) as typeof fetch;

// ── Six bots ─────────────────────────────────────────────────────────────────
const bots = ['telegram', 'discord', 'cli-agent', 'support', 'cron', 'qa'].map(name => ({
  name,
  ...createBot({ name, rpmLimit: 100, dailyLimit: 1000, concurrency: 2, priority: 5 }),
}));

const app = createApp();
const server: Server = app.listen(0, '127.0.0.1');
if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
const port = (server.address() as AddressInfo).port;
const url = `http://127.0.0.1:${port}/v1/chat/completions`;

const BOT_REQUESTS = 4;
const started = Date.now();
const results = await Promise.all(bots.flatMap(bot =>
  Array.from({ length: BOT_REQUESTS }, async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bot.key}`,
      },
      body: JSON.stringify({ model: MODEL_ID, messages: [{ role: 'user', content: 'ping' }] }),
    });
    const body = await res.json() as { choices?: unknown[]; error?: { message: string } };
    return {
      bot: bot.name,
      status: res.status,
      ok: res.status === 200 && Array.isArray(body.choices) && body.choices.length > 0,
      error: body.error?.message,
    };
  }),
));

globalThis.fetch = originalFetch;

const successes = results.filter(r => r.ok).length;
const failures = results.filter(r => !r.ok);
const metrics = getMetricsSnapshot();
console.log('=== bot fault simulation ===');
console.log(JSON.stringify({
  bots: bots.length,
  requests_per_bot: BOT_REQUESTS,
  total_requests: results.length,
  successes,
  failures: failures.length,
  failure_samples: failures.slice(0, 3),
  upstream_forced_429: observed429,
  upstream_forced_500: observed500,
  upstream_successful_responses: observed200,
  router_failovers: metrics.failovers,
  rate_limits_seen_by_health: metrics.rate_limits,
  upstream_errors_seen_by_health: metrics.upstream_errors,
  queue: queueStats(),
  elapsed_ms: Date.now() - started,
}, null, 2));

await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));

// ── Tunnel smoke test for every mode ─────────────────────────────────────────
console.log('\n=== tunnel smoke tests ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-sim-'));
function fakeBinary(name: string, body: string): string {
  const file = path.join(tmp, process.platform === 'win32' ? `${name}.cmd` : name);
  fs.writeFileSync(file, process.platform === 'win32' ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return file;
}
const stayAlive = process.platform === 'win32' ? 'ping -n 15 127.0.0.1 > nul' : 'sleep 15';
const { createServer } = await import('node:http');
const ngrokApi = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ tunnels: [{ proto: 'https', public_url: 'https://sim.ngrok-free.app' }] }));
});
await new Promise<void>(resolve => ngrokApi.listen(0, '127.0.0.1', resolve));
const apiPort = (ngrokApi.address() as AddressInfo).port;

const modes: Array<{ mode: string; env: Record<string, string> }> = [
  { mode: 'local', env: { TUNNEL: 'local' } },
  {
    mode: 'cloudflare',
    env: {
      TUNNEL: 'cloudflare',
      CLOUDFLARED_BIN: fakeBinary('sim-cloudflared', `echo https://sim-123.trycloudflare.com\r\n${stayAlive}`),
      CLOUDFLARE_TUNNEL_TOKEN: '',
    },
  },
  {
    mode: 'tailscale',
    env: {
      TUNNEL: 'tailscale',
      TAILSCALE_BIN: fakeBinary('sim-tailscale', 'echo configured'),
      TAILSCALE_HOSTNAME: 'sim.ts.net',
    },
  },
  {
    mode: 'ngrok',
    env: {
      TUNNEL: 'ngrok',
      NGROK_BIN: fakeBinary('sim-ngrok', stayAlive),
      NGROK_API_PORT: String(apiPort),
      NGROK_AUTHTOKEN: 'simulated-token',
    },
  },
];

for (const item of modes) {
  for (const [key, value] of Object.entries(item.env)) process.env[key] = value;
  // Clear the other modes' overrides so discovery does not cross-contaminate.
  for (const key of ['CLOUDFLARE_TUNNEL_TOKEN', 'TAILSCALE_HOSTNAME', 'NGROK_AUTHTOKEN']) {
    if (!(key in item.env)) delete process.env[key];
  }
  const status = await startTunnel();
  const url = await waitForTunnelUrl(5000);
  console.log(JSON.stringify({
    mode: item.mode,
    binary_found: item.mode === 'local'
      ? true
      : Boolean(findBinary(item.mode as 'cloudflare' | 'tailscale' | 'ngrok')),
    url,
    active: getTunnelStatus().active,
    auth_required: status.authRequired,
    skip_warning_header: status.skipWarningHeader,
  }));
  await stopTunnel();
}

await new Promise<void>(resolve => ngrokApi.close(() => resolve()));
fs.rmSync(tmp, { recursive: true, force: true });
