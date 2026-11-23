import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  findBinary,
  getTunnelConfig,
  getTunnelStatus,
  setTunnelMode,
  startTunnel,
  stopTunnel,
  waitForTunnelUrl,
} from '../../services/tunnel.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-tunnel-'));

function fakeBinary(name: string, body: string): string {
  const file = path.join(tmp, process.platform === 'win32' ? `${name}.cmd` : name);
  fs.writeFileSync(file, process.platform === 'win32'
    ? `@echo off\r\n${body}\r\n`
    : `#!/bin/sh\n${body}\n`);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return file;
}

const stayAlive = process.platform === 'win32'
  ? 'ping -n 30 127.0.0.1 > nul'
  : 'sleep 30';

describe('tunnel manager', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterAll(async () => {
    await stopTunnel();
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('parses TUNNEL from the environment and rejects unknown modes (fallback local)', () => {
    for (const mode of ['local', 'cloudflare', 'tailscale', 'ngrok'] as const) {
      vi.stubEnv('TUNNEL', mode);
      expect(getTunnelConfig().mode).toBe(mode);
    }
    vi.stubEnv('TUNNEL', 'carrier-pigeon');
    expect(getTunnelConfig().mode).toBe('local');
  });

  it('finds a binary through the explicit override', () => {
    const bin = fakeBinary('fake-cf', 'echo ok');
    vi.stubEnv('CLOUDFLARED_BIN', bin);
    expect(findBinary('cloudflare')).toBe(bin);
  });

  it('local mode prints a /v1 URL and requires no public auth surface', async () => {
    vi.stubEnv('TUNNEL', 'local');
    const status = await startTunnel();
    expect(status.mode).toBe('local');
    expect(status.url).toBe(`${getTunnelConfig().localUrl}/v1`);
    expect(status.active).toBe(true);
    expect(status.authRequired).toBe(false);
    expect(status.pid).toBeNull();
  });

  it('cloudflare quick tunnel smoke test: fake binary URL is discovered', async () => {
    const bin = fakeBinary('fake-cloudflared', `echo https://smoke-1234.trycloudflare.com\r\n${stayAlive}`);
    vi.stubEnv('TUNNEL', 'cloudflare');
    vi.stubEnv('CLOUDFLARED_BIN', bin);
    vi.stubEnv('CLOUDFLARE_TUNNEL_TOKEN', '');
    const status = await startTunnel();
    expect(status.active).toBe(true);
    expect(status.authRequired).toBe(true);
    expect(status.command).toContain('--url');
    expect(await waitForTunnelUrl(5000)).toBe('https://smoke-1234.trycloudflare.com/v1');
    await stopTunnel();
  });

  it('tailscale serve smoke test: hostname from env, one-shot command', async () => {
    const bin = fakeBinary('fake-tailscale', 'echo configured');
    vi.stubEnv('TUNNEL', 'tailscale');
    vi.stubEnv('TAILSCALE_BIN', bin);
    vi.stubEnv('TAILSCALE_MODE', 'serve');
    vi.stubEnv('TAILSCALE_HOSTNAME', 'gateway.smoke.ts.net');
    const status = await startTunnel();
    expect(status.command).toContain('tailscale serve --bg');
    expect(await waitForTunnelUrl(5000)).toBe('https://gateway.smoke.ts.net/v1');
    await stopTunnel();
  });

  it('ngrok smoke test: URL comes from its local API and skip-warning header is exposed', async () => {
    let mock: Server | null = null;
    let apiPort = 4040;
    // Bind a real local HTTP server, then point the tunnel at it.
    const { createServer } = await import('node:http');
    mock = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tunnels: [{ proto: 'https', public_url: 'https://smoke.ngrok-free.app' }] }));
    });
    await new Promise<void>(resolve => mock!.listen(0, '127.0.0.1', resolve));
    apiPort = (mock.address() as { port: number }).port;

    const bin = fakeBinary('fake-ngrok', stayAlive);
    vi.stubEnv('TUNNEL', 'ngrok');
    vi.stubEnv('NGROK_BIN', bin);
    vi.stubEnv('NGROK_API_PORT', String(apiPort));
    vi.stubEnv('NGROK_DOMAIN', 'smoke.ngrok-free.app');
    vi.stubEnv('NGROK_AUTHTOKEN', 'not-a-real-token');

    const status = await startTunnel();
    expect(status.command).toContain('--domain smoke.ngrok-free.app');
    expect(status.command).not.toContain('not-a-real-token');
    expect(status.skipWarningHeader).toBe('Ngrok-Skip-Browser-Warning: 1');
    expect(await waitForTunnelUrl(5000)).toBe('https://smoke.ngrok-free.app/v1');
    await stopTunnel();
    await new Promise<void>(resolve => mock!.close(() => resolve()));
  });

  it('persists a dashboard-selected mode and applies it over a stale env value', () => {
    vi.stubEnv('TUNNEL', 'local');
    setTunnelMode('ngrok');
    expect(getTunnelConfig().mode).toBe('ngrok');
    expect(() => setTunnelMode('carrier-pigeon' as never)).toThrow(/Unknown tunnel mode/);
    setTunnelMode('local');
    expect(getTunnelConfig().mode).toBe('local');
  });

  it('getTunnelStatus never leaks a token', () => {
    vi.stubEnv('NGROK_AUTHTOKEN', 'super-secret-token');
    const json = JSON.stringify(getTunnelStatus());
    expect(json).not.toContain('super-secret-token');
  });
});
