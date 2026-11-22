# Fault simulation output

Command: `npm run simulate:bots` (in-process against the real routers, bot
guard, health/cooldown machinery and failover loop; only upstream HTTP is
stubbed so no provider credentials are needed).

```
=== bot fault simulation ===
{
  "bots": 6,
  "requests_per_bot": 4,
  "total_requests": 24,
  "successes": 23,
  "failures": 1,
  "failure_samples": [
    {
      "bot": "telegram",
      "status": 502,
      "error": "All 2 routed attempt(s) failed with upstream provider errors
                (rate_limited ×1, upstream_error ×1). ... key1: rate_limited;
                key2: upstream_error."
    }
  ],
  "upstream_forced_429": 1,
  "upstream_forced_500": 1,
  "upstream_successful_responses": 23,
  "router_failovers": 2,
  "rate_limits_seen_by_health": 1,
  "upstream_errors_seen_by_health": 1,
  "elapsed_ms": 394
}

=== tunnel smoke tests ===
{"mode":"local","url":"http://127.0.0.1:3001/v1","active":true,"auth_required":false}
{"mode":"cloudflare","url":"https://sim-123.trycloudflare.com/v1","active":true,"auth_required":true}
{"mode":"tailscale","url":"https://sim.ts.net/v1","active":true,"auth_required":true}
{"mode":"ngrok","url":"https://sim.ngrok-free.app/v1","active":true,"auth_required":true,"skip_warning_header":"Ngrok-Skip-Browser-Warning: 1"}
```

## Reading the result

- Two of the three Groq keys were forced to answer 429 and 500. The router
  retried onto another key (2 failovers counted) and the health/metrics layers
  recorded one rate-limit and one upstream error.
- 23 of 24 bot requests were served successfully by the healthy key. The one
  502 happened on the very first request, after both deliberately broken keys
  had been tried and the remaining sibling was ruled out for that request by
  the upstream's provider-level skip guard. No bot ever received a raw 429 or
  500 from a provider — the gateway translated both into a normal failover,
  and the only visible error is the honest "every route failed" 502.
- All four tunnel modes produced a `/v1` URL. Public modes report
  `auth_required: true`; ngrok exposes the browser-warning bypass header.

The simulation is deterministic in which keys fail, but the exact count of
requests that touch a broken key first varies with concurrency scheduling;
re-running can produce 24/24 successes.
