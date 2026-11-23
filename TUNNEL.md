# Tunnel modes

Run the gateway behind one link. Set `TUNNEL` in `.env` or pass `--tunnel` on start
(the CLI flag wins). The server prints the final URL with `/v1` at boot and the
dashboard shows it under **Keys → API key → Public tunnel** with a copy button.

```bash
./scripts/start.sh --tunnel cloudflare     # or: .\scripts\start.ps1 --tunnel ngrok
npm start -- --tunnel tailscale             # direct Node entry also parses the flag
```

Available modes: `local` (default), `cloudflare`, `tailscale`, `ngrok`.

## local

No child process. Binds to `HOST`/`PORT` — dual-stack `::` by default, or set
`TUNNEL_BIND=lan` (+ optional `LAN_HOST`) to print the LAN address. Not public.

## cloudflare

- **Quick**: leave `CLOUDFLARE_TUNNEL_TOKEN` unset. `cloudflared tunnel --url`
  prints a `https://<random>.trycloudflare.com` URL, which the manager parses
  from the process output. The URL changes on restart.
- **Named**: set `CLOUDFLARE_TUNNEL_TOKEN` and `CLOUDFLARE_HOSTNAME`. The manager
  runs `cloudflared tunnel run --token …` and publishes `https://$CLOUDFLARE_HOSTNAME/v1`.
  The token never appears in logs, `/api/tunnel`, `/metrics` or the dashboard.

Install `cloudflared` from Cloudflare's official apt/repo page, or point
`CLOUDFLARED_BIN` at the binary.

## tailscale

`TAILSCALE_MODE=serve` (default) publishes inside your tailnet; `funnel` makes it
public. The manager runs `tailscale serve --bg $PORT` (or `funnel --bg $PORT`) —
a one-shot command that hands the listener to `tailscaled`. The public URL comes
from `TAILSCALE_HOSTNAME` when set, otherwise from `tailscale status --json`.

## ngrok

```dotenv
TUNNEL=ngrok
NGROK_AUTHTOKEN=...              # required for a stable URL
NGROK_DOMAIN=gateway.ngrok-free.app   # optional reserved domain
NGROK_REGION=us                  # optional
NGROK_API_PORT=4040              # local agent API used for URL discovery
```

The manager runs `ngrok http $PORT --authtoken … --domain …` and reads the public
URL from `http://127.0.0.1:$NGROK_API_PORT/api/tunnels`. Without an authtoken the
agent still starts, but the URL is random and short-lived; a warning is logged.

**Browser warning:** ngrok shows an interstitial to browsers. Send
`Ngrok-Skip-Browser-Warning: 1` with requests (bots too). The dashboard's copy
button emits a ready `curl` command with this header, and
`GET /api/tunnel` returns it in `skipWarningHeader`.

## Reconnects and operations

- If a cloudflared/ngrok child exits unexpectedly, it restarts with exponential
  backoff (1s → 2s → … → 30s). Each reconnect increments
  `freellmapi_tunnel_reconnects_total` and is reported in `/metrics`.
- `POST /api/tunnel/{start,stop,restart}` (dashboard session required) controls
  the tunnel live. `GET /api/tunnel/binaries` reports which binaries were found.
- `POST /api/tunnel/mode` with `{"mode":"local|cloudflare|tailscale|ngrok"}`
  switches mode at runtime and persists the choice. The dashboard mode selector
  on **Keys → API key → Public tunnel** uses it. A persisted choice wins over a
  stale `.env` value on the next boot; an explicit `--tunnel` CLI flag still
  wins over both.
- Graceful shutdown kills the child on SIGINT/SIGTERM.
- **Public modes never disable authentication.** `/v1` still requires the unified
  or bot key; `/api/*` still requires the dashboard session. Set `TRUST_PROXY`
  and `ALLOWED_HOSTS` when a reverse proxy is in front.
- Docker: `Dockerfile.tunnel` builds a variant with cloudflared, tailscale and
  ngrok installed from their official repositories. Tokens belong in `-e` /
  secrets, never in the image.
- systemd: see `deploy/freellmapi.service` (use an `EnvironmentFile` with 0600
  permissions for tokens).
