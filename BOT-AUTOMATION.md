# Bot automation additions

Everything here is additive to the upstream gateway; the existing `/v1` routes,
keys, dashboard and MIT license are unchanged.

## Bot virtual keys

Create one from the dashboard (**Keys → API key**) or `POST /api/bots`:

```bash
curl -X POST http://localhost:3001/api/bots \
  -H "Authorization: Bearer $DASHBOARD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"telegram-bot","rpmLimit":30,"tpmLimit":200000,"dailyLimit":2000,"priority":9,"concurrency":4,"allowedModels":["fast","smart"]}'
```

The response contains `key` (`sk-bot-…`) **once**. Only its SHA-256 digest is
stored for auth; the encrypted copy is for masked display. Use it like any
OpenAI key:

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-bot-..." -H 'Content-Type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"ping"}]}'
```

- RPM and TPM use in-memory sliding windows; the daily cap is persisted in
  `bot_usage` and survives restarts. Exceeding any cap returns **429** with
  `Retry-After`.
- `allowedModels` restricts which model ids a bot may request.
- `routing_strategy` (balanced/smartest/fastest/reliable) biases that bot's
  routing without changing the global setting.
- `GET /api/bots/:id/usage?days=7` returns lifetime and daily request/token
  totals. Counters are exported per bot as `freellmapi_bot_*` in `/metrics`.

## Priority queue

Each bot gets its own concurrency budget (`concurrency`, default 2) plus a
process-wide ceiling (`BOT_QUEUE_CONCURRENCY`, default 64). Requests queue by
priority with aging, so a busy high-priority bot cannot starve a low-priority
one. `BOT_QUEUE_MAX_DEPTH` (512) and `BOT_QUEUE_TIMEOUT_MS` (30000) bound the
wait. Full queue → 503; deadline → 504, both with `Retry-After`.

The gateway already had key-level health, cooldowns, quota switching, circuit
penalties, hedged requests, an identical-request cache, request timeouts and
SSE streaming; bot keys sit in front of that machinery, not beside it.

## Routing strategies and aliases

`TUNNEL` is for exposure; `ROUTING_STRATEGY` (or `PUT /api/fallback/routing`) is
for selection. In addition to upstream presets:

| strategy | behaviour |
|---|---|
| `round-robin` | pure rotation across a model's keys; no per-key bandit |
| `least-used` | key with fewest requests in the last 24h first |
| `lowest-latency` | key with the lowest observed TTFB first (fastest model preset) |

Model aliases: `auto` (balanced), `fast` (fastest), `smart` (smartest), `coding`
(quality-led; existing task-type detection handles code/tool bias). All four
route through the full `auto` failover chain and appear in `/v1/models`.

## Ops

- Keep-alive pooling (75s inbound, undici upstream) and optional HTTP/2 for
  direct upstream calls via `UPSTREAM_HTTP2=1`. SSE responses are never buffered
  or gzipped.
- `GET /health` — readiness with key status, cooldowns, bot counts and traffic.
- `GET /metrics` — Prometheus counters/gauges (no auth, no secrets).
- `GET /livez`, `GET /readyz` — unchanged load-balancer probes.
- `./scripts/start.sh --tunnel …` / `scripts/start.ps1`, `Dockerfile.tunnel`,
  `deploy/freellmapi.service` — deployment entry points.

See `TUNNEL.md` for tunnel-specific configuration and `AGENT.md` for architecture.
