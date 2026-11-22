// In-process metrics registry. Deliberately dependency-free: a Prometheus
// client library would add a dependency and a second cardinality model. All
// writes are O(1) map updates on the request hot path; /metrics reads a shallow
// copy. Counters are process-lifetime, gauges are set by their owners.

export interface TunnelInfo {
  mode: 'local' | 'cloudflare' | 'tailscale' | 'ngrok' | string;
  url: string | null;
  active: boolean;
  reconnects: number;
}

export interface MetricsSnapshot {
  requests_total: number;
  requests_failed: number;
  tokens_total: number;
  failovers: number;
  rate_limits: number;
  upstream_errors: number;
  cache_hits: number;
  cache_misses: number;
  queue_enqueued: number;
  queue_rejected: number;
  in_flight: number;
  queue_depth: number;
  bot_requests: Record<string, number>;
  bot_tokens: Record<string, number>;
  key_failovers: Record<string, number>;
  tunnel: TunnelInfo;
}

interface Registry extends MetricsSnapshot {}

const SYMBOL = Symbol.for('freellmapi.metrics.registry');

function blank(): Registry {
  return {
    requests_total: 0,
    requests_failed: 0,
    tokens_total: 0,
    failovers: 0,
    rate_limits: 0,
    upstream_errors: 0,
    cache_hits: 0,
    cache_misses: 0,
    queue_enqueued: 0,
    queue_rejected: 0,
    in_flight: 0,
    queue_depth: 0,
    bot_requests: Object.create(null) as Record<string, number>,
    bot_tokens: Object.create(null) as Record<string, number>,
    key_failovers: Object.create(null) as Record<string, number>,
    tunnel: { mode: 'local', url: null, active: false, reconnects: 0 },
  };
}

type GlobalWithRegistry = typeof globalThis & { [SYMBOL]?: Registry };
const globalRef = globalThis as GlobalWithRegistry;
const registry: Registry = globalRef[SYMBOL] ?? blank();
globalRef[SYMBOL] = registry;

function bump(map: Record<string, number>, key: string, by = 1): void {
  // Cap cardinality: a caller-controlled string must never be able to grow the
  // registry without bound. Bot names and key labels are operator-set, but a
  // strict cap is cheap insurance for a long-lived gateway.
  if (!key || key.length > 120) return;
  const keys = Object.keys(map);
  if (!(key in map) && keys.length >= 500) return;
  map[key] = (map[key] ?? 0) + by;
}

export function recordRequest(): void { registry.requests_total++; }
export function recordFailedRequest(): void { registry.requests_failed++; }
export function recordTokens(n: number): void {
  if (Number.isFinite(n) && n > 0) registry.tokens_total += Math.floor(n);
}
export function recordFailover(keyLabel?: string): void {
  registry.failovers++;
  if (keyLabel) bump(registry.key_failovers, keyLabel);
}
export function recordRateLimit(): void { registry.rate_limits++; }
export function recordUpstreamError(): void { registry.upstream_errors++; }
export function recordCacheHit(): void { registry.cache_hits++; }
export function recordCacheMiss(): void { registry.cache_misses++; }
export function recordQueueEnqueued(): void { registry.queue_enqueued++; }
export function recordQueueRejected(): void { registry.queue_rejected++; }
export function setInFlight(n: number): void { registry.in_flight = Math.max(0, n); }
export function setQueueDepth(n: number): void { registry.queue_depth = Math.max(0, n); }
export function recordBotRequest(name: string): void { bump(registry.bot_requests, name); }
export function recordBotTokens(name: string, n: number): void {
  if (Number.isFinite(n) && n > 0) bump(registry.bot_tokens, name, Math.floor(n));
}

export function setTunnelInfo(info: Partial<TunnelInfo>): void {
  if (info.mode !== undefined) registry.tunnel.mode = info.mode;
  if (info.url !== undefined) registry.tunnel.url = info.url;
  if (info.active !== undefined) registry.tunnel.active = info.active;
  if (info.reconnects !== undefined) registry.tunnel.reconnects = info.reconnects;
}
export function recordTunnelReconnect(): void { registry.tunnel.reconnects++; }

export function getMetricsSnapshot(): MetricsSnapshot {
  return {
    ...registry,
    bot_requests: { ...registry.bot_requests },
    bot_tokens: { ...registry.bot_tokens },
    key_failovers: { ...registry.key_failovers },
    tunnel: { ...registry.tunnel },
  };
}

/** Test helper. Not exported from any HTTP surface. */
export function resetMetrics(): void {
  const fresh = blank();
  for (const k of Object.keys(registry)) delete (registry as unknown as Record<string, unknown>)[k];
  Object.assign(registry, fresh);
}
