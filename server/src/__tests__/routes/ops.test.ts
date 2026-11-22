import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  resetMetrics,
  recordRequest,
  recordFailedRequest,
  recordTokens,
  recordFailover,
  recordBotRequest,
  recordBotTokens,
  setTunnelInfo,
} from '../../services/metrics.js';

async function call(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const text = await res.text();
  server.close();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* metrics is text */ }
  return { status: res.status, text, body, contentType: res.headers.get('content-type') ?? '' };
}

describe('ops endpoints: /health and /metrics', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('/health reports 503 with a machine-readable reason before any upstream', async () => {
    const { status, body } = await call(app, '/health');
    expect(status).toBe(503);
    expect(body.reason).toBe('no_upstreams_configured');
    expect(body.checks.db).toBe(true);
    expect(body.version).toMatch(/^0\./);
  });

  it('/health reaches 200 once a healthy upstream key exists', async () => {
    const secret = encrypt('ops-test-key');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'ops', ?, ?, ?, 'healthy', 1)
    `).run(secret.encrypted, secret.iv, secret.authTag);

    const { status, body } = await call(app, '/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.upstreams.healthy_keys).toBeGreaterThanOrEqual(1);
    expect(body.traffic_24h).toBeDefined();
  });

  it('/metrics exposes Prometheus counters, gauges and labelled bot series', async () => {
    resetMetrics();
    recordRequest();
    recordRequest();
    recordFailedRequest();
    recordTokens(1234);
    recordFailover('groq:key-2');
    recordBotRequest('telegram-bot');
    recordBotTokens('telegram-bot', 500);
    setTunnelInfo({ mode: 'cloudflare', url: 'https://example.trycloudflare.com/v1', active: true });

    const { status, text, contentType } = await call(app, '/metrics');
    expect(status).toBe(200);
    expect(contentType).toContain('text/plain');
    expect(text).toContain('# TYPE freellmapi_requests_total counter');
    expect(text).toMatch(/^freellmapi_requests_total 2$/m);
    expect(text).toMatch(/^freellmapi_requests_failed_total 1$/m);
    expect(text).toMatch(/^freellmapi_request_tokens_total 1234$/m);
    expect(text).toMatch(/^freellmapi_bot_requests_total\{bot="telegram-bot"\} 1$/m);
    expect(text).toMatch(/^freellmapi_bot_tokens_total\{bot="telegram-bot"\} 500$/m);
    expect(text).toMatch(/^freellmapi_key_failovers_total\{key="groq:key-2"\} 1$/m);
    expect(text).toContain('mode="cloudflare"');
    expect(text).toContain('https://example.trycloudflare.com/v1');
    expect(text).toMatch(/^freellmapi_tunnel_up 1$/m);
  });

  it('/metrics escapes label values and caps cardinality', async () => {
    resetMetrics();
    recordBotRequest('bot"with\nnewline\\slash');
    const { text } = await call(app, '/metrics');
    expect(text).toContain('bot="bot\\"with\\nnewline\\\\slash"');
  });
});
