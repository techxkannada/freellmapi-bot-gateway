# Benchmark: baseline vs bot-automation branch

Measured on the same Windows host (Node v22.23.5, 40 keep-alive connections,
12-second runs, `autocannon` via `npm run bench`). "Before" is the branch point
`ralph/freellmapi-selfhost` @ `7ad9097` checked out into a separate git worktree
with the same `node_modules`; "after" is this branch. Both servers ran with
`PROXY_RATE_LIMIT_RPM=1000000` and `ADMIN_RATE_LIMIT_RPM=1000000` so the
rate-limiter could not dominate the result, `HOST=127.0.0.1`, `TUNNEL=local`,
independent temporary SQLite databases. Each endpoint was warmed by one full
run before the numbers below were taken.

| endpoint | before req/s | after req/s | before p50-ish latency | after p50-ish latency | result |
|---|---:|---:|---:|---:|---|
| `GET /api/ping` | 1766 | 2020 | 22.18 ms | 19.29 ms | ~14% higher RPS (within run-to-run variance) |
| `GET /v1/models` (auth) | 79 | 78 | 494.4 ms | 502.5 ms | parity (≤2%) |

The first cold `/v1/models` pass showed 66 → 54 req/s; a repeat with both
servers warm showed 79 → 78, so the gap was warm-up noise, not a code change.
No regression is attributable to the bot guard or the four new alias entries.

New endpoints (no baseline exists — they did not exist before):

| endpoint | after req/s | latency | notes |
|---|---:|---:|---|
| `GET /health` | 1315 | 29.87 ms | SQLite rollups + counters; 503 until an upstream key exists (dummy healthy key inserted for this run) |
| `GET /metrics` | 692 | 57.43 ms | in-process counters + OS gauges; 0 errors, 0 non-2xx |

Reproduce:

```bash
# terminal 1
FREEAPI_DB_PATH=/tmp/bench.db PROXY_RATE_LIMIT_RPM=1000000 \
ADMIN_RATE_LIMIT_RPM=1000000 npm start
# terminal 2
FREEAPI_BENCH_KEY=<unified key from the dashboard> \
npm run bench -- http://127.0.0.1:3001 /v1/models 12 40
```

Honest read: the latency-heavy work in this gateway is upstream provider calls,
local request parsing and SQLite analytics; the additions here are O(1) per
request on the hot path (a prefix check, a counter bump, a map lookup). The
measurable win is operational — bots no longer collide (per-bot concurrency),
failovers are automatic, and `/health` + `/metrics` make saturation visible —
not a large synthetic RPS jump.
