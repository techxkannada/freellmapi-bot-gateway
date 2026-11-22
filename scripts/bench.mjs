#!/usr/bin/env node
// Load benchmark for the gateway's local HTTP surface.
//
//   node scripts/bench.mjs http://127.0.0.1:3001 /v1/models 20 40
//
// Positional args: base URL, path, duration seconds, connections. Prints a
// stable JSON line { path, duration_s, connections, req_per_s, latency_ms,
// throughput_mb_s, errors, non_2xx } so before/after runs can be diffed.
//
// The target must be a locally started gateway. The benchmark uses the unified
// key from FREEAPI_BENCH_KEY when the path needs auth; set it from the dashboard
// (Keys → API key) or leave it unset for unauthenticated paths like /health.

import autocannon from 'autocannon';

const [baseUrl = 'http://127.0.0.1:3001', requestPath = '/health', durationArg = '15', connArg = '40', method = 'GET'] = process.argv.slice(2);
const duration = Number(durationArg);
const connections = Number(connArg);
const url = `${baseUrl.replace(/\/$/, '')}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;

const headers = {};
if (process.env.FREEAPI_BENCH_KEY) headers.authorization = `Bearer ${process.env.FREEAPI_BENCH_KEY}`;
if (method === 'POST') headers['content-type'] = 'application/json';

const body = method === 'POST'
  ? JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'benchmark' }] })
  : undefined;

const result = await autocannon({
  url,
  method,
  connections,
  duration,
  headers,
  body,
  pipelining: 1,
});

const summary = {
  path: requestPath,
  duration_s: duration,
  connections,
  req_per_s: Math.round(result.requests.mean),
  latency_ms: +result.latency.mean.toFixed(2),
  throughput_mb_s: +(result.throughput.mean / 1024 / 1024).toFixed(2),
  errors: result.errors,
  non_2xx: result.non2xx,
};
console.log(JSON.stringify(summary));
