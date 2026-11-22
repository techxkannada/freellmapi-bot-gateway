# Complete access manual — commands, methods, endpoints

This is the "how do I reach/use everything" reference for this self-hosted fork.
Paths are relative to the repo root. The server listens on `PORT` (default
**3001**) and `HOST` (default `::`). Dashboard is at `http://localhost:3001/`.

---

## 0. Access in 60 seconds

```bash
npm install
npm run build
npm start                            # or: ./scripts/start.sh --tunnel local
# Windows: .\scripts\start.ps1 --tunnel local
```

First boot mints a unified API key and prints a one-time setup code to the
server log. Open `http://localhost:3001/`, finish setup, then get the key from
**Keys → API key**. Nothing in `/v1` works without a credential.

```bash
curl http://localhost:3001/health
curl http://localhost:3001/v1/models -H "Authorization: Bearer $API_KEY"
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

---

## 1. Credentials (which key opens which door)

| credential | prefix | opens | where to get it |
|---|---|---|---|
| unified API key | `freellmapi-…` | all `/v1`, `/v1beta`, `/mcp`, `/v1/providers`, `/v1/quota-forecast`, `/v1/usage` | `GET /api/settings/api-key` (dashboard session) |
| bot virtual key | `sk-bot-…` | all inference surfaces, with its own quota/priority/concurrency | `POST /api/bots` (full key shown once) |
| client-profile key | `sk-cp-…` | inference with a server-enforced system prompt | `POST /api/client-profiles` |
| URL token | opaque | headerless clients, via `/v1/t/:token/*` | `POST /api/settings/url-tokens` |
| dashboard token | session cookie / bearer | every `/api/*` admin route | `POST /api/auth/login` |

Headers accepted for inference credentials: `Authorization: Bearer …`,
`x-api-key: …`, `x-goog-api-key: …`. Public tunnel modes **never** remove auth.

---

## 2. Every npm command

### Root (`package.json`)

| command | what it does |
|---|---|
| `npm run dev` | server + client dev servers with HMR |
| `npm run dev:lan` | same, client bound to LAN |
| `npm run build` | builds server, CLI and client |
| `npm run build:server` | server only (`tsc`) |
| `npm start` | runs built server (`node server/dist/index.js`) |
| `npm test` | bootstrap + hook tests + all three workspace suites |
| `npm run test:bootstrap` | `scripts/dev-bootstrap.test.mjs` |
| `npm run test:hooks` | contributor-hook tests |
| `npm run test:migrations` | migration round-trip suite |
| `npm run lint` | ESLint server + CLI |
| `npm run db:migration:up` / `:down` / `:fresh` / `:status` / `:create` | migration CLI |
| `npm run bench -- <url> <path> <seconds> <connections>` | autocannon benchmark (JSON) |
| `npm run simulate:bots` | 6-bot forced 429/500 + tunnel smoke test |
| `npm run desktop:dev` / `desktop:dist` / `desktop:dist:win` / `desktop:dist:linux` | Electron builds (out of fork scope) |

### Server workspace (`npm run <script> -w server`)

`dev`, `build`, `start`, `test`, `test:watch`, `test:coverage`,
`test:migrations`, `lint`, `export-catalog`, `rotate-encryption-key`,
`db:migration:{up,down,fresh,status,create}`.

### CLI workspace (`npm run <script> -w cli`)

`build`, `test`, `lint`, `prepublishOnly`. Installed binary: `freellmapi`.

---

## 3. Every CLI command

```bash
npx freellmapi <command> [--url URL] [--api-key KEY] [--profile NAME] [--model ID] [--dry-run]
```

| command | purpose |
|---|---|
| `setup-claude`, `setup-codex`, `setup-cline`, `setup-continue`, `setup-aider`, `setup-opencode`, `setup-goose`, `setup-qwen`, `setup-roo`, `setup-kilo`, `setup-crush`, `setup-dsh`, `setup-mimo`, `setup-atomcode`, `setup-openclaw`, `setup-hermes`, `setup-pi`, `setup-reasonix`, `setup-zcode`, `setup-cursor`, `setup-generic` | configure that coding agent to point at this gateway (`--dry-run` prints the diff) |
| `doctor [tool]` | probe whether a tool's requests actually reach the gateway; `--timeout MS` |
| `launch` | run Claude Code with credentials injected |
| `launch-codex` | run Codex CLI with provider overrides |
| `list` | list supported agents |
| `keys add <platform> [--key VALUE]` | add a provider key (hidden prompt when `--key` omitted) |
| `keys list` | list provider keys |
| `keys test <platform> [--id N]` | validate stored keys |
| `keys remove <platform> --id N` | delete a provider key |
| `help`, `--help`, `-h` | built-in help |

Environment: `FREELLMAPI_URL`, `FREELLMAPI_API_KEY`,
`FREELLMAPI_DASHBOARD_TOKEN` (for `keys` commands).

---

## 4. Start / tunnel commands

```bash
./scripts/start.sh --tunnel ngrok          # Linux/macOS
.\scripts\start.ps1 --tunnel cloudflare    # Windows
npm start -- --tunnel tailscale            # direct
TUNNEL=local npm start                     # via .env
```

| mode | what starts | URL source |
|---|---|---|
| `local` | nothing | `HOST:PORT` (or `LAN_HOST` when `TUNNEL_BIND=lan`) |
| `cloudflare` | `cloudflared tunnel --url` or `tunnel run --token` | generated `*.trycloudflare.com` output or `CLOUDFLARE_HOSTNAME` |
| `tailscale` | `tailscale serve --bg $PORT` / `funnel --bg $PORT` | `TAILSCALE_HOSTNAME` or `tailscale status --json` |
| `ngrok` | `ngrok http $PORT --authtoken …` | local agent API on `NGROK_API_PORT` |

Docker:

```bash
docker build -t freellmapi:local .
docker build -f Dockerfile.tunnel --build-arg BASE=freellmapi:local -t freellmapi:tunnel .
docker run -p 3001:3001 -e TUNNEL=cloudflare -e CLOUDFLARE_TUNNEL_TOKEN=... freellmapi:tunnel
```

systemd: copy `deploy/freellmapi.service` to `/etc/systemd/system/`, put secrets
in an `EnvironmentFile` with mode 0600, then
`systemctl daemon-reload && systemctl enable --now freellmapi`.

See `TUNNEL.md` for every tunnel env var and the reconnect behaviour.

---

## 5. Every public / inference HTTP method

### Unauthenticated

| method | path | purpose |
|---|---|---|
| GET | `/health` | full readiness snapshot (JSON) |
| GET | `/metrics` | Prometheus text exposition |
| GET | `/livez` | liveness (DB + encryption key) |
| GET | `/readyz` | readiness (at least one serviceable upstream) |
| GET | `/api/ping` | trivial ping |
| GET | `/v1/docs` | API reference viewer |
| GET | `/v1/openapi.json` | OpenAPI spec |
| GET | `/` and SPA routes | dashboard bundle |

### Unified key (or bot/profile key where noted)

| method | path | purpose |
|---|---|---|
| GET | `/v1/models` | model catalog, aliases, chains |
| GET | `/v1/models/:id` | retrieve one model |
| GET | `/v1/models?available=true` | filter by servability |
| GET | `/v1/codex/models`, `/v1/text/models` | client-specific model lists |
| POST | `/v1/chat/completions` | OpenAI chat (streaming SSE supported) |
| POST | `/v1/completions` | legacy text completions |
| POST | `/v1/responses` | OpenAI Responses API (Codex) |
| POST | `/v1/messages`, `/v1/messages/count_tokens` | Anthropic Messages API |
| GET | `/v1/models` with `anthropic-version` | Anthropic-shaped model list |
| POST | `/v1/embeddings` | embeddings |
| POST | `/v1/rerank` | reranking |
| POST | `/v1/moderations` | moderation shim |
| POST | `/v1/images/generations` | image generation |
| POST | `/v1/videos/generations` | video generation |
| POST | `/v1/audio/speech`, `/v1/audio/transcriptions` | TTS / STT |
| POST | `/v1/search` | web search |
| GET | `/v1/search/engines` | available search engines |
| POST | `/v1/decisions`, `/v1/systemone` | decision-model routing |
| GET | `/v1/decisions/models` | decision-capable models |
| POST | `/v1/text/:path` | specialist text routes |
| GET | `/v1/usage` | monthly usage (unified key only) |
| GET | `/v1/providers` | per-upstream health rollup |
| GET | `/v1/quota-forecast` | daily headroom / low balance |
| ANY | `/v1/t/:token/*` | same inference routes via URL token |

### Gemini wire (`/v1beta`, key via `x-goog-api-key` or `?key=`)

| method | path |
|---|---|
| GET | `/v1beta/models` |
| GET | `/v1beta/models/:name` |
| POST | `/v1beta/models/:name:generateContent` |
| POST | `/v1beta/models/:name:streamGenerateContent` |
| POST | `/v1beta/models/:name:countTokens` |

### Ollama emulation (unauthenticated by design, rate-limited)

`GET /api/tags`, `GET /api/version`, `POST /api/show`, `POST /api/chat`,
`POST /api/generate`, `POST /api/embed`, `POST /api/embeddings`.

### MCP (`/mcp`, unified/bot key)

`GET /mcp` (tools list), `POST /mcp` (JSON-RPC tool call), `DELETE /mcp`.

### Dashboard session (`/api/*`)

| group | methods and paths |
|---|---|
| auth (public bootstrap) | `GET /api/auth/status`, `GET /api/auth/me`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/desktop-session`, `POST /api/auth/change-email`, `POST /api/auth/change-password`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` |
| keys | `GET/POST /api/keys`, `GET /api/keys/providers`, `GET /api/keys/export`, `GET /api/keys/keyless-available`, `POST /api/keys/keyless-available/{enable,dismiss}`, `GET/PATCH/DELETE /api/keys/:id`, `DELETE /api/keys/:id/cooldowns`, `DELETE /api/keys/:id/cooldowns/checkin`, `POST /api/keys/:id/reveal`, `POST /api/keys/{custom,import,preview,import-selected,discovered-models,custom/discover-models,custom/probe}`, `PATCH /api/keys/platform/:platform` |
| models | `GET/POST /api/models`, `GET/PATCH/DELETE /api/models/:id`, `POST /api/models/:id/test`, `DELETE /api/models/custom/:id` |
| client profiles | `GET/POST /api/client-profiles`, `PATCH /api/client-profiles/:id`, `POST /api/client-profiles/:id/rotate`, `DELETE /api/client-profiles/:id` |
| **bots (new)** | `GET/POST /api/bots`, `GET /api/bots/queue`, `GET/PATCH/DELETE /api/bots/:id`, `POST /api/bots/:id/rotate`, `GET /api/bots/:id/usage?days=7` |
| **tunnel (new)** | `GET /api/tunnel`, `GET /api/tunnel/binaries`, `POST /api/tunnel/start`, `POST /api/tunnel/stop`, `POST /api/tunnel/restart` |
| fallback/routing | `GET/PUT /api/fallback`, `GET/PUT /api/fallback/routing`, `GET /api/fallback/quota-forecast`, `GET /api/fallback/token-usage`, `GET /api/fallback/rate-limit-usage`, `GET/DELETE /api/fallback/penalty-inspector`, `POST /api/fallback/sort/:preset` |
| profiles | `GET/POST /api/profiles`, `GET /api/profiles/active`, `POST /api/profiles/active`, `GET /api/profiles/:id/models`, `PUT/DELETE /api/profiles/:id`, `POST /api/profiles/:id/reset`, `PUT /api/profiles/:id/reorder`, `POST /api/profiles/:id/sort/:preset` |
| health | `GET /api/health`, `POST /api/health/check/:keyId`, `POST /api/health/check-all`, `POST /api/health/quota/:keyId`, `POST /api/health/probe-models` |
| analytics | `GET /api/analytics/{summary,search,by-model,by-platform,by-client,by-key,timeline,error-distribution,errors,requests,requests/:id}` |
| embeddings / media / search / decisions | `GET/POST/PUT/DELETE` under `/api/embeddings`, `/api/media`, `/api/search`, `/api/decisions` (see each router) |
| conversations / logs | `GET/POST /api/conversations`, `GET/PUT/DELETE /api/conversations/:id`, `GET /api/logs`, `POST /api/logs/clear` |
| cache / compression | `GET /api/cache/stats`, `PUT /api/cache/config`, `DELETE /api/cache`; `GET /api/compression/stats`, `POST /api/compression/preview` |
| settings | `GET /api/settings/{version,update-check,compression,unify,fusion,enable-mcp,anthropic-map,gemini-map,agent-compatibility,url-tokens,output-limit,min-context-window,guardrails,headroom,task-weight-share,min-reliability-floor,provider-moment-attribution,api-key,proxy}` and matching `PUT`/`POST`/`DELETE` variants, plus `POST /api/settings/api-key/regenerate`, `POST /api/settings/proxy/test` |
| backups | `GET/POST /api/backups`, `GET /api/backups/tables`, `GET/PUT /api/backups/schedule`, `GET /api/backups/:id/download`, `POST /api/backups/:id/restore`, `DELETE /api/backups/:id` |
| premium / updates | `GET/POST/DELETE` under `/api/premium`, `GET /api/update/{release,check,status}`, `POST /api/update/apply` |

---

## 6. Bot features — exact usage

```bash
# create (full key once)
curl -X POST http://localhost:3001/api/bots -H "Authorization: Bearer $DASH" \
  -H 'Content-Type: application/json' \
  -d '{"name":"telegram","rpmLimit":30,"tpmLimit":200000,"dailyLimit":2000,
       "priority":9,"concurrency":4,"allowedModels":["fast","smart"],
       "routingStrategy":"fastest"}'
# -> {"bot":{...},"key":"sk-bot-..."}

# use it
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-bot-..." -H 'Content-Type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"ping"}]}'

# inspect / control
curl http://localhost:3001/api/bots -H "Authorization: Bearer $DASH"
curl http://localhost:3001/api/bots/1/usage?days=7 -H "Authorization: Bearer $DASH"
curl http://localhost:3001/api/bots/queue -H "Authorization: Bearer $DASH"
curl -X POST http://localhost:3001/api/bots/1/rotate -H "Authorization: Bearer $DASH"
curl -X PATCH http://localhost:3001/api/bots/1 -H "Authorization: Bearer $DASH" \
  -H 'Content-Type: application/json' -d '{"enabled":false,"priority":2}'
curl -X DELETE http://localhost:3001/api/bots/1 -H "Authorization: Bearer $DASH"
```

429 includes `Retry-After`. Queue full → 503, queue deadline → 504.

---

## 7. Tunnel control — exact usage

```bash
curl http://localhost:3001/api/tunnel -H "Authorization: Bearer $DASH"
curl http://localhost:3001/api/tunnel/binaries -H "Authorization: Bearer $DASH"
curl -X POST http://localhost:3001/api/tunnel/start -H "Authorization: Bearer $DASH"
curl -X POST http://localhost:3001/api/tunnel/restart -H "Authorization: Bearer $DASH"
curl -X POST http://localhost:3001/api/tunnel/stop -H "Authorization: Bearer $DASH"
```

For ngrok, send `Ngrok-Skip-Browser-Warning: 1` from every client.

---

## 8. Routing control — exact usage

```bash
# config file (FREEAPI_CONFIG_PATH) or inline JSON (FREEAPI_CONFIG_JSON)
{"routing":{"strategy":"round-robin","keySelectionStrategy":"least-used"}}
# or at runtime:
curl -X PUT http://localhost:3001/api/fallback/routing \
  -H "Authorization: Bearer $DASH" -H 'Content-Type: application/json' \
  -d '{"strategy":"lowest-latency"}'
# or env: ROUTING_STRATEGY=round-robin
```

Strategies: `priority`, `balanced`, `smartest`, `fastest`, `reliable`,
`round-robin`, `least-used`, `lowest-latency`, `custom`, `decision`.
Key policies: `auto`, `least-remaining`, `round-robin`, `least-used`,
`lowest-latency`. Model aliases: `auto`, `fast`, `smart`, `coding`.

---

## 9. Programmatic methods (import from the fork)

```ts
import { createBot, listBots, updateBot, deleteBot, rotateBotKey,
  checkBotQuota, recordBotUsage, botUsageStats, getBotByToken } from './server/src/services/bot-keys.js';
import { acquireSlot, queueStats, resetQueue } from './server/src/services/bot-queue.js';
import { getTunnelConfig, startTunnel, stopTunnel, restartTunnel,
  getTunnelStatus, waitForTunnelUrl, findBinary, installTunnelShutdown } from './server/src/services/tunnel.js';
import { getMetricsSnapshot, resetMetrics, recordFailover, recordBotRequest } from './server/src/services/metrics.js';
import { getRoutingStrategy, setRoutingStrategy, effectiveKeySelectionStrategy,
  setKeySelectionStrategy } from './server/src/services/router.js';
import { applyModelAlias, normalizeModelAlias, modelAliasEntries } from './server/src/services/model-aliases.js';
```

Each function's behaviour is documented in the file it lives in; `AGENT.md`
maps the surrounding architecture.

---

## 10. Ops commands

```bash
curl http://localhost:3001/health
curl http://localhost:3001/metrics
npm run test:migrations
npm run export-catalog -w server
npm run rotate-encryption-key -w server
npm run bench -- http://127.0.0.1:3001 /v1/models 12 40
npm run simulate:bots
```

---

## 11. Environment variables that matter here

`PORT`, `HOST`, `FREEAPI_DB_PATH`, `ENCRYPTION_KEY`, `TUNNEL`,
`TUNNEL_AUTOSTART`, `TUNNEL_BIND`, `LAN_HOST`, `CLOUDFLARE_TUNNEL_TOKEN`,
`CLOUDFLARE_HOSTNAME`, `CLOUDFLARED_BIN`, `TAILSCALE_MODE`,
`TAILSCALE_HOSTNAME`, `TAILSCALE_BIN`, `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`,
`NGROK_REGION`, `NGROK_API_PORT`, `NGROK_BIN`, `BOT_QUEUE_CONCURRENCY`,
`BOT_QUEUE_MAX_DEPTH`, `BOT_QUEUE_TIMEOUT_MS`, `ROUTING_STRATEGY`,
`UPSTREAM_HTTP2`, `PROXY_RATE_LIMIT_RPM`, `ADMIN_RATE_LIMIT_RPM`,
`TRUST_PROXY`, `ALLOWED_HOSTS`, `DASHBOARD_ORIGINS`,
`REQUEST_BODY_LIMIT_MB`, `FREEAPI_CONFIG_JSON`, `FREEAPI_CONFIG_PATH`.
Full list with comments: `.env.example`.
