// Tunnel manager for self-hosted gateways.
//
// TUNNEL=local|cloudflare|tailscale|ngrok (or `npm start -- --tunnel ngrok`).
// One process owns one tunnel child. It detects the binary, starts it with the
// operator's credentials from the environment, discovers the public URL, prints
// it with the /v1 suffix, exposes it to the dashboard and reconnects with
// exponential backoff if the child dies. Public modes never disable auth: the
// gateway's unified key and dashboard session are still the only way in.
//
// No secrets are logged: tokens are passed as argv/environment to the child,
// never echoed into status, metrics or the dashboard response.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { recordTunnelReconnect, setTunnelInfo } from './metrics.js';
import { getUnifiedApiKey } from '../db/index.js';

const execFileAsync = promisify(execFile);

export type TunnelMode = 'local' | 'cloudflare' | 'tailscale' | 'ngrok';
export const TUNNEL_MODES: readonly TunnelMode[] = ['local', 'cloudflare', 'tailscale', 'ngrok'];

export interface TunnelConfig {
  mode: TunnelMode;
  port: number;
  host: string;
  localUrl: string;
  cloudflare: { token: string | null; hostname: string | null; quick: boolean };
  tailscale: { serve: boolean; funnel: boolean; hostname: string | null };
  ngrok: { authtoken: string | null; domain: string | null; apiPort: number; region: string | null };
  autoStart: boolean;
}

export interface TunnelStatus {
  mode: TunnelMode;
  active: boolean;
  url: string | null;
  localUrl: string;
  binary: string | null;
  pid: number | null;
  reconnects: number;
  lastError: string | null;
  startedAt: string | null;
  authRequired: boolean;
  skipWarningHeader: string | null;
  command: string | null;
}

// ── Configuration ────────────────────────────────────────────────────────────

function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function fromArgv(): TunnelMode | null {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--tunnel') continue;
    if (arg.startsWith('--tunnel=')) {
      const value = arg.slice('--tunnel='.length).trim().toLowerCase() as TunnelMode;
      return TUNNEL_MODES.includes(value) ? value : null;
    }
    // `--tunnel ngrok` — the following token was consumed by the loop already;
    // handled below by reading the raw argv index.
  }
  const idx = process.argv.indexOf('--tunnel');
  if (idx >= 0) {
    const value = process.argv[idx + 1]?.trim().toLowerCase() as TunnelMode;
    if (value && TUNNEL_MODES.includes(value)) return value;
  }
  return null;
}

function parseMode(): TunnelMode {
  const argvMode = fromArgv();
  const raw = (argvMode ?? env('TUNNEL') ?? 'local').toLowerCase();
  return (TUNNEL_MODES as readonly string[]).includes(raw) ? raw as TunnelMode : 'local';
}

function lanAddress(): string {
  const configured = env('LAN_HOST');
  if (configured) return configured;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (!a.internal && a.family === 'IPv4') return a.address;
    }
  }
  return '127.0.0.1';
}

export function getTunnelConfig(): TunnelConfig {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '::';
  const mode = parseMode();
  const bindLan = env('TUNNEL_BIND') === 'lan';
  const displayHost = mode === 'local' && bindLan ? lanAddress() : (host === '::' ? '127.0.0.1' : host);
  return {
    mode,
    port,
    host,
    localUrl: `http://${displayHost}:${port}`,
    cloudflare: {
      token: env('CLOUDFLARE_TUNNEL_TOKEN'),
      hostname: env('CLOUDFLARE_HOSTNAME'),
      quick: !env('CLOUDFLARE_TUNNEL_TOKEN'),
    },
    tailscale: {
      serve: (env('TAILSCALE_MODE') ?? 'serve') !== 'funnel',
      funnel: env('TAILSCALE_MODE') === 'funnel',
      hostname: env('TAILSCALE_HOSTNAME'),
    },
    ngrok: {
      authtoken: env('NGROK_AUTHTOKEN'),
      domain: env('NGROK_DOMAIN'),
      apiPort: Number(env('NGROK_API_PORT') ?? 4040),
      region: env('NGROK_REGION'),
    },
    autoStart: (env('TUNNEL_AUTOSTART') ?? '1') !== '0',
  };
}

// ── Binary discovery ─────────────────────────────────────────────────────────

const BINARY_NAMES: Record<Exclude<TunnelMode, 'local'>, string[]> = {
  cloudflare: ['cloudflared'],
  tailscale: ['tailscale'],
  ngrok: ['ngrok'],
};

export function findBinary(mode: Exclude<TunnelMode, 'local'>): string | null {
  const names = BINARY_NAMES[mode];
  const overrides: Record<string, string | null> = {
    cloudflare: env('CLOUDFLARED_BIN'),
    tailscale: env('TAILSCALE_BIN'),
    ngrok: env('NGROK_BIN'),
  };
  const candidates = [overrides[mode], ...names].filter((n): n is string => Boolean(n));
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extraDirs = [
    '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin',
    path.join(os.homedir(), 'bin'),
    'C:\\Program Files\\Cloudflared',
    'C:\\Program Files\\Tailscale',
    'C:\\Program Files\\ngrok',
  ];
  for (const name of candidates) {
    const isPath = name.includes('/') || name.includes('\\');
    const bases = isPath ? [path.dirname(name)] : [...pathDirs, ...extraDirs];
    const file = isPath ? path.basename(name) : name;
    for (const base of bases) {
      const needsExe = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(file);
      const full = path.join(base, needsExe ? `${file}.exe` : file);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch { /* unreadable path — keep looking */ }
    }
  }
  return null;
}

// ── Runtime state ────────────────────────────────────────────────────────────

let child: ChildProcess | null = null;
let stopping = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelayMs = 1000;
let urlPollTimer: NodeJS.Timeout | null = null;
let lastError: string | null = null;
let startedAt: string | null = null;
let reconnects = 0;
let discoveredUrl: string | null = null;
let binaryPath: string | null = null;
let commandShown: string | null = null;
let configSnapshot: TunnelConfig = getTunnelConfig();

function publish(): TunnelStatus {
  const status: TunnelStatus = {
    mode: configSnapshot.mode,
    active: configSnapshot.mode === 'local' || Boolean(discoveredUrl || child?.pid),
    url: publicUrl(),
    localUrl: configSnapshot.localUrl,
    binary: binaryPath,
    pid: child?.pid ?? null,
    reconnects,
    lastError,
    startedAt,
    authRequired: configSnapshot.mode !== 'local',
    skipWarningHeader: configSnapshot.mode === 'ngrok' ? 'Ngrok-Skip-Browser-Warning: 1' : null,
    command: commandShown,
  };
  setTunnelInfo({
    mode: status.mode,
    url: status.url,
    active: status.active,
    reconnects: status.reconnects,
  });
  return status;
}

export function getTunnelStatus(): TunnelStatus {
  return publish();
}

function publicUrl(): string | null {
  if (!discoveredUrl) return null;
  return discoveredUrl.replace(/\/$/, '') + '/v1';
}

function sanitizeLine(line: string): string {
  // Drop anything that looks like a token assignment before it can reach logs.
  return line.replace(/(token|authtoken|secret|key)[=: ]+\S+/gi, '$1=[redacted]').slice(0, 300);
}

function setDiscoveredUrl(url: string): void {
  if (discoveredUrl) return;
  discoveredUrl = url.replace(/\/$/, '');
  console.log(`[tunnel] public URL: ${publicUrl()}`);
  publish();
}

function captureUrl(line: string): void {
  if (configSnapshot.mode !== 'cloudflare') return;
  // Only a quick-tunnel URL appears in cloudflared's output. A named tunnel
  // uses CLOUDFLARE_HOSTNAME; ngrok/tailscale URLs come from their APIs.
  const found = line.match(/https:\/\/[\w-]+\.trycloudflare\.com/)?.[0];
  if (found) setDiscoveredUrl(found);
}

// ── URL discovery ────────────────────────────────────────────────────────────

async function ngrokApiUrl(): Promise<string | null> {
  const port = configSnapshot.ngrok.apiPort;
  for (const scheme of ['http', 'https']) {
    try {
      const res = await fetch(`${scheme}://127.0.0.1:${port}/api/tunnels`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) continue;
      const data = await res.json() as { tunnels?: Array<{ proto?: string; public_url?: string }> };
      const https = data.tunnels?.find(t => t.proto === 'https')?.public_url;
      const http = data.tunnels?.find(t => t.proto === 'http')?.public_url;
      return https ?? http ?? null;
    } catch { /* API not up yet */ }
  }
  return null;
}

async function tailscaleHostname(): Promise<string | null> {
  if (configSnapshot.tailscale.hostname) {
    const h = configSnapshot.tailscale.hostname;
    return /^https?:\/\//.test(h) ? h : `https://${h}`;
  }
  if (!binaryPath) return null;
  try {
    const { stdout } = await execFileAsync(binaryPath, ['status', '--json'], { timeout: 5000 });
    const parsed = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName?.replace(/\.$/, '');
    return dns ? `https://${dns}` : null;
  } catch {
    return null;
  }
}

function startUrlPolling(): void {
  stopUrlPolling();
  if (configSnapshot.mode === 'local') return;
  urlPollTimer = setInterval(async () => {
    if (configSnapshot.mode === 'ngrok' && !discoveredUrl) {
      const url = await ngrokApiUrl();
      if (url) setDiscoveredUrl(url);
    } else if (configSnapshot.mode === 'tailscale' && !discoveredUrl) {
      const url = await tailscaleHostname();
      if (url) setDiscoveredUrl(url);
    }
  }, 1500);
  urlPollTimer.unref?.();
}

function stopUrlPolling(): void {
  if (urlPollTimer) clearInterval(urlPollTimer);
  urlPollTimer = null;
}

// ── Command construction ─────────────────────────────────────────────────────

function buildCommand(): { args: string[]; shown: string; env: NodeJS.ProcessEnv } {
  const cfg = configSnapshot;
  const local = `http://127.0.0.1:${cfg.port}`;
  const childEnv = { ...process.env };
  switch (cfg.mode) {
    case 'cloudflare': {
      if (cfg.cloudflare.token) {
        return {
          args: ['tunnel', 'run', '--token', cfg.cloudflare.token],
          shown: 'cloudflared tunnel run --token [redacted]',
          env: childEnv,
        };
      }
      return { args: ['tunnel', '--no-autoupdate', '--url', local], shown: `cloudflared tunnel --url ${local}`, env: childEnv };
    }
    case 'tailscale': {
      const action = cfg.tailscale.funnel ? 'funnel' : 'serve';
      return { args: [action, '--bg', String(cfg.port)], shown: `tailscale ${action} --bg ${cfg.port}`, env: childEnv };
    }
    case 'ngrok': {
      const args = ['http', String(cfg.port), '--log=stdout', '--log-format=logfmt'];
      const shown = ['ngrok', 'http', String(cfg.port)];
      if (cfg.ngrok.authtoken) { args.push('--authtoken', cfg.ngrok.authtoken); shown.push('--authtoken', '[redacted]'); }
      if (cfg.ngrok.domain) { args.push('--domain', cfg.ngrok.domain); shown.push('--domain', cfg.ngrok.domain); }
      if (cfg.ngrok.region) { args.push('--region', cfg.ngrok.region); shown.push('--region', cfg.ngrok.region); }
      return { args, shown: shown.join(' '), env: childEnv };
    }
    case 'local':
      return { args: [], shown: `${cfg.localUrl}/v1`, env: childEnv };
  }
}

function spawnChild(): void {
  const cfg = configSnapshot;
  if (cfg.mode === 'local') return;
  binaryPath = findBinary(cfg.mode);
  if (!binaryPath) {
    lastError = `${cfg.mode} binary not found on PATH — install ${cfg.mode === 'cloudflare' ? 'cloudflared' : cfg.mode}`;
    console.error(`[tunnel] ${lastError}`);
    publish();
    return;
  }
  const { args, shown, env: childEnv } = buildCommand();
  commandShown = shown;
  console.log(`[tunnel] starting ${cfg.mode}: ${shown}`);
  try {
    child = spawn(binaryPath, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Node >=20 refuses to spawn .cmd/.bat directly on Windows (EINVAL).
      // Real cloudflared/tailscale/ngrok ship .exe and take the direct path.
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath),
    });
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[tunnel] ${cfg.mode} failed to start: ${lastError}`);
    publish();
    return;
  }
  child.stdout?.on('data', (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) captureUrl(line);
    }
  });
  child.stderr?.on('data', (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      captureUrl(line);
      if (/error|failed|unauthorized|invalid/i.test(line)) lastError = sanitizeLine(line);
    }
  });
  child.on('error', err => {
    lastError = err.message;
    console.error(`[tunnel] ${cfg.mode} failed to start: ${err.message}`);
  });
  const spawned = child;
  spawned.on('exit', code => {
    // A child that was already replaced by stop/restart is stale: its exit
    // event can arrive after the next start cleared `stopping`, and would
    // otherwise schedule a bogus reconnect for the NEW mode.
    if (spawned !== child) return;
    if (stopping) return;
    // `tailscale serve --bg` / `funnel --bg` are one-shot commands: they hand
    // the listener to the tailscaled daemon and exit. The URL poll against
    // `tailscale status` is the source of truth, so the CLI exiting is not an
    // outage and must not start a reconnect loop.
    if (cfg.mode === 'tailscale') return;
    discoveredUrl = null;
    lastError = lastError ?? `${cfg.mode} exited with code ${code ?? 'unknown'}`;
    scheduleReconnect();
  });
  startUrlPolling();
}

function scheduleReconnect(): void {
  if (stopping || reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(30_000, reconnectDelayMs * 2);
  console.warn(`[tunnel] ${configSnapshot.mode} disconnected — reconnecting in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnects++;
    recordTunnelReconnect();
    spawnChild();
  }, delay);
  reconnectTimer.unref?.();
}

// ── Public control API ───────────────────────────────────────────────────────

export async function startTunnel(): Promise<TunnelStatus> {
  stopping = false;
  configSnapshot = getTunnelConfig();
  reconnects = 0;
  reconnectDelayMs = 1000;
  lastError = null;
  discoveredUrl = null;
  binaryPath = null;
  commandShown = null;

  if (configSnapshot.mode !== 'local') {
    // Fail closed: a public tunnel must never run without an inference
    // credential. getUnifiedApiKey mints one on a fresh install; reading it
    // here guarantees the dashboard can hand it to the operator.
    getUnifiedApiKey();
    if (configSnapshot.mode === 'ngrok' && !configSnapshot.ngrok.authtoken && !env('NGROK_AUTHTOKEN')) {
      lastError = 'NGROK_AUTHTOKEN is not set — ngrok will expose a random, short-lived URL';
      console.warn(`[tunnel] ${lastError}`);
    }
    spawnChild();
  } else if (configSnapshot.mode === 'local') {
    discoveredUrl = configSnapshot.localUrl;
  } else if (configSnapshot.mode === 'cloudflare' && configSnapshot.cloudflare.hostname) {
    // Named tunnels publish at the operator's hostname, not at a generated one.
    discoveredUrl = `https://${configSnapshot.cloudflare.hostname.replace(/^https?:\/\//, '')}`;
  } else if (configSnapshot.mode === 'tailscale' && configSnapshot.tailscale.hostname) {
    discoveredUrl = `https://${configSnapshot.tailscale.hostname.replace(/^https?:\/\//, '')}`;
  }

  startedAt = new Date().toISOString();
  return publish();
}

export async function stopTunnel(): Promise<TunnelStatus> {
  stopping = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopUrlPolling();
  const proc = child;
  child = null;
  if (proc && proc.pid && !proc.killed) {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
  discoveredUrl = null;
  startedAt = null;
  return publish();
}

export async function restartTunnel(): Promise<TunnelStatus> {
  await stopTunnel();
  return startTunnel();
}

/** Wait until the public URL is known (or the deadline passes). */
export async function waitForTunnelUrl(timeoutMs = 20_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = publicUrl();
    if (url) return url;
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
  return null;
}

/** Wire graceful shutdown: kill the tunnel child before the process exits. */
export function installTunnelShutdown(): void {
  const shutdown = () => { void stopTunnel(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
