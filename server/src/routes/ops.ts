// Operational endpoints for self-hosted bot automation:
//
//   GET /health   — human-readable liveness + readiness snapshot (no auth).
//   GET /metrics  — Prometheus text exposition, format 0.0.4 (no auth).
//
// Both are deliberately cheap: a handful of indexed SQLite aggregates and a
// read of in-process counters. No provider key, decrypted secret, request body
// or caller identifier ever leaves through them. They are mounted before the
// SPA fallback but after the admin rate limiter, so a scraper cannot spin on
// /metrics without being throttled by the same /api bucket as the dashboard.

import { Router } from 'express';
import type { Request, Response } from 'express';
import os from 'os';
import { getDb } from '../db/index.js';
import { isEncryptionKeyInitialized } from '../lib/crypto.js';
import { getMetricsSnapshot, type MetricsSnapshot } from '../services/metrics.js';

export const opsRouter = Router();

const VERSION = '0.2.1-bot-automation';
const STARTED_AT = Date.now();

interface DbSnapshot {
  keys: number;
  healthyKeys: number;
  unhealthyKeys: number;
  enabledKeys: number;
  coolingKeys: number;
  profiles: number;
  bots: number;
  requests24h: number;
  failures24h: number;
}

function dbSnapshot(): DbSnapshot {
  const db = getDb();
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const keys = db.prepare(`
    SELECT
      COUNT(*) AS keys,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_keys,
      SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) AS healthy_keys,
      SUM(CASE WHEN status IN ('invalid', 'error') THEN 1 ELSE 0 END) AS unhealthy_keys
    FROM api_keys
  `).get() as Record<string, number | null>;

  const cooling = db.prepare(
    'SELECT COUNT(*) AS n FROM rate_limit_cooldowns WHERE expires_at_ms > ?',
  ).get(Date.now()) as { n: number | null };

  const profiles = db.prepare('SELECT COUNT(*) AS n FROM client_profiles').get() as { n: number };
  let bots = 0;
  try {
    bots = (db.prepare("SELECT COUNT(*) AS n FROM bot_keys WHERE seed_version = 'live'").get() as { n: number }).n;
  } catch {
    // The bot-key table is created by its own migration; an install that has
    // not run it yet still gets a valid health report.
  }

  let requests24h = 0;
  let failures24h = 0;
  try {
    const req = db.prepare(
      'SELECT COUNT(*) AS n FROM requests WHERE created_at >= ?',
    ).get(dayAgo) as { n: number };
    requests24h = req.n;
    const fail = db.prepare(
      "SELECT COUNT(*) AS n FROM requests WHERE created_at >= ? AND status = 'error'",
    ).get(dayAgo) as { n: number };
    failures24h = fail.n;
  } catch {
    // Analytics schema varies between installs; the counters are advisory.
  }

  return {
    keys: keys.keys ?? 0,
    enabledKeys: keys.enabled_keys ?? 0,
    healthyKeys: keys.healthy_keys ?? 0,
    unhealthyKeys: keys.unhealthy_keys ?? 0,
    coolingKeys: cooling.n ?? 0,
    profiles: profiles.n ?? 0,
    bots,
    requests24h,
    failures24h,
  };
}

function readiness(snap: DbSnapshot): { ready: boolean; reason: string } {
  if (!isEncryptionKeyInitialized()) {
    return { ready: false, reason: 'encryption_key_not_loaded' };
  }
  if (snap.enabledKeys === 0) {
    return { ready: false, reason: 'no_upstreams_configured' };
  }
  if (snap.healthyKeys === 0 && snap.coolingKeys === 0) {
    return { ready: false, reason: 'all_upstreams_unhealthy' };
  }
  return { ready: true, reason: 'ok' };
}

// GET /health — liveness + readiness with the signals an operator needs to
// decide "restart it" vs "wait for cooldown", without exposing key material.
opsRouter.get('/health', (_req: Request, res: Response) => {
  let snap: DbSnapshot;
  try {
    snap = dbSnapshot();
  } catch {
    res.status(503).json({ status: 'unavailable', reason: 'db_unreachable' });
    return;
  }

  const { ready, reason } = readiness(snap);
  const metrics = getMetricsSnapshot();
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unavailable',
    reason,
    version: VERSION,
    uptime_s: Math.floor(process.uptime()),
    started_at: new Date(STARTED_AT).toISOString(),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    checks: {
      db: true,
      encryption_key: isEncryptionKeyInitialized(),
    },
    upstreams: {
      keys: snap.keys,
      enabled_keys: snap.enabledKeys,
      healthy_keys: snap.healthyKeys,
      unhealthy_keys: snap.unhealthyKeys,
      cooling_keys: snap.coolingKeys,
    },
    consumers: {
      client_profiles: snap.profiles,
      bot_keys: snap.bots,
    },
    traffic_24h: {
      requests: snap.requests24h,
      failures: snap.failures24h,
      fail_rate: snap.requests24h > 0 ? +(snap.failures24h / snap.requests24h).toFixed(4) : 0,
    },
    proxy: {
      in_flight: metrics.in_flight,
      queued: metrics.queue_depth,
      routed: metrics.requests_total,
      failed: metrics.requests_failed,
      failovers: metrics.failovers,
    },
    tunnel: metrics.tunnel,
  });
});

// Prometheus escaping: label values only need backslash, quote and newline
// escaped for text exposition 0.0.4.
function label(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function counter(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}`;
}

function gauge(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
}

function labelledCounter(
  name: string,
  help: string,
  labelName: string,
  series: Record<string, number>,
): string[] {
  const entries = Object.entries(series).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return [];
  const out = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
  for (const [value, count] of entries) {
    out.push(`${name}{${labelName}="${label(value)}"} ${count}`);
  }
  return out;
}

// GET /metrics — scrape target for Prometheus/VictoriaMetrics. Counter values
// come from the in-process registry; gauges from SQLite and the OS. Kept in
// plain text with no compression so it works through every tunnel mode.
opsRouter.get('/metrics', (_req: Request, res: Response) => {
  const m: MetricsSnapshot = getMetricsSnapshot();
  const snap = (() => {
    try { return dbSnapshot(); } catch { return null; }
  })();

  const lines: string[] = [
    '# HELP freellmapi_build_info Build information.',
    '# TYPE freellmapi_build_info gauge',
    `freellmapi_build_info{version="${label(VERSION)}",node="${label(process.version)}",platform="${label(process.platform)}"} 1`,
    gauge('freellmapi_up', '1 when the process is alive and the DB answers.', snap ? 1 : 0),
    gauge('freellmapi_uptime_seconds', 'Process uptime in seconds.', Math.floor(process.uptime())),
    counter('freellmapi_requests_total', 'Inference requests received by the proxy.', m.requests_total),
    counter('freellmapi_requests_failed_total', 'Inference requests that exhausted every route.', m.requests_failed),
    counter('freellmapi_request_tokens_total', 'Approximate input+output tokens processed.', m.tokens_total),
    counter('freellmapi_failovers_total', 'Automatic retries onto another key, provider or model.', m.failovers),
    counter('freellmapi_rate_limits_total', 'Upstream 429s observed.', m.rate_limits),
    counter('freellmapi_upstream_errors_total', 'Upstream 5xx / timeouts observed.', m.upstream_errors),
    counter('freellmapi_cache_hits_total', 'Identical-request cache hits.', m.cache_hits),
    counter('freellmapi_cache_misses_total', 'Identical-request cache misses.', m.cache_misses),
    counter('freellmapi_queue_enqueued_total', 'Requests admitted to the priority queue.', m.queue_enqueued),
    counter('freellmapi_queue_rejected_total', 'Requests rejected by a full queue.', m.queue_rejected),
    gauge('freellmapi_in_flight', 'Requests currently executing upstream.', m.in_flight),
    gauge('freellmapi_queue_depth', 'Requests waiting for a concurrency slot.', m.queue_depth),
    gauge('freellmapi_process_resident_bytes', 'Resident set size from the OS.', process.memoryUsage.rss()),
    gauge('freellmapi_load1', 'Host 1-minute load average (0 on platforms without it).', os.loadavg()[0] ?? 0),
  ];

  lines.push(...labelledCounter(
    'freellmapi_bot_requests_total',
    'Requests made with a bot virtual key.',
    'bot',
    m.bot_requests,
  ));
  lines.push(...labelledCounter(
    'freellmapi_bot_tokens_total',
    'Tokens consumed by a bot virtual key.',
    'bot',
    m.bot_tokens,
  ));
  lines.push(...labelledCounter(
    'freellmapi_key_failovers_total',
    'Times a provider key was bypassed after a failure.',
    'key',
    m.key_failovers,
  ));

  if (snap) {
    lines.push(
      gauge('freellmapi_upstream_keys', 'Configured provider keys.', snap.keys),
      gauge('freellmapi_upstream_keys_enabled', 'Enabled provider keys.', snap.enabledKeys),
      gauge('freellmapi_upstream_keys_healthy', 'Provider keys last seen healthy.', snap.healthyKeys),
      gauge('freellmapi_upstream_keys_unhealthy', 'Provider keys last seen invalid or errored.', snap.unhealthyKeys),
      gauge('freellmapi_upstream_keys_cooling', 'Provider keys under an active cooldown.', snap.coolingKeys),
      gauge('freellmapi_bot_keys', 'Live bot virtual keys.', snap.bots),
    );
  }

  const t = m.tunnel;
  lines.push(
    gauge('freellmapi_tunnel_up', '1 when the configured tunnel URL is live.', t.active ? 1 : 0),
    '# HELP freellmapi_tunnel_info Tunnel mode and public URL.',
    '# TYPE freellmapi_tunnel_info gauge',
    `freellmapi_tunnel_info{mode="${label(t.mode)}",url="${label(t.url ?? '')}"} 1`,
    counter('freellmapi_tunnel_reconnects_total', 'Tunnel process reconnects.', t.reconnects),
  );

  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(lines.join('\n') + '\n');
});
