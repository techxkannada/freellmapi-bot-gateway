# AGENT.md — FreeLLMAPI fork architecture

Self-hosted Node.js OpenAI-compatible LLM gateway. This fork keeps upstream's
MIT license and credit (see `LICENSE`, Copyright (c) 2026 Tashfeen Ahmed) and
targets **bot automation on a self-hosted box only** — no Android/APK work.

## 1. Monorepo layout

| Workspace | Role |
|---|---|
| `server/` | Express 5 + TypeScript gateway. Owns SQLite, routing, all `/v1`, `/api`, `/v1beta`, `/mcp` surfaces. Built with `tsc` into `server/dist`. |
| `client/` | Vite + React dashboard (Keys, Models, Playground, Analytics, Profiles, Fallback, Media, etc.). Built into `client/dist`, served by the server. |
| `cli/` | Node CLI that talks to the gateway's admin API. |
| `shared/` | `types.ts` (wire types) plus `agent-setup.ts`. |
| `desktop/` | Electron packaging of the same server + client (not part of this fork's scope). |
| `docs/`, `examples/`, `scripts/` | Guides, client examples, dev bootstrap. |

Root scripts: `npm run dev` (both server + client with HMR), `npm run build`,
`npm test` (bootstrap + hooks + server vitest + cli + client), `npm run lint`.
Node `>=20.18 <25`, npm `>=10`.

## 2. Boot sequence (`server/src/index.ts`)

1. `installLogRedaction()` at module scope — provider keys never reach stdout.
2. `loadConfig()` (`lib/config.ts`): PORT (3001), HOST (`::`), FREEAPI_DB_PATH,
   DASHBOARD_ORIGINS, PROXY_RATE_LIMIT_RPM, REQUEST_BODY_LIMIT_MB (25), TRUST_PROXY,
   CSP_UPGRADE_INSECURE_REQUESTS, ALLOWED_HOSTS.
3. `installProcessSafetyNet()`, then DB restore/backup checks, `initDb()`, declarative
   config from env, routing-override drift warning.
4. `loadCacheFromDb()`, expired-cooldown sweep, first-run setup code, `restoreProxySettings()`.
5. `createApp(config)` → `app.listen()` with tuned keep-alive (75s / 76s headers).
6. On ready: health checker, catalog sync, cooldown probe, model probe, backup
   schedulers, custom/builtin model discovery, wake detection, graceful shutdown.

## 3. HTTP surface (`server/src/app.ts`)

Middleware order matters:
- `allowed-hosts` DNS-rebinding guard → helmet/CSP → doubled-`/v1` collapse →
  CORS → two-tier JSON body limits → client context (AsyncLocalStorage) →
  Ollama `/api/*` → `/api` admin rate limiter → dashboard auth.
- `/api/*` admin routes are behind a dashboard session (`requireAuth`) except
  `/api/auth/*` and `/api/ping`.
- `/v1/*` inference routes use the unified API key or an `sk-cp-*` client-profile
  key; they have their own per-IP rate limiter and are mounted in this order:
  docs/providers → URL tokens → Anthropic → OpenAI proxy → moderation →
  Responses → Gemini (`/v1beta`) → MCP (`/mcp`).
- `/livez`, `/readyz` (`routes/status.ts`) are unauthenticated probes. `/v1/providers`
  and `/v1/quota-forecast` are unified-key-gated machine introspection.
- Static client bundle + SPA fallback are last; `compression()` wraps **only**
  dashboard assets, never the SSE proxy streams.

## 4. Request lifecycle (the hot path)

`routes/proxy.ts` → `requireInferenceAuth` (`resolveAuth` in `lib/system-prompt.ts`)
→ body/model normalization → `services/fallback-loop.ts` drives attempts:
1. `services/router.ts` ranks models (bandit presets `priority|balanced|smartest|
   fastest|reliable|custom|decision`, with guardrails for quota headroom and 429s)
   and selects a key per platform (`KeySelectionStrategy = auto|least-remaining`,
   round-robin fallback). Aliases, profiles/chains and model groups refine the candidate set.
2. `lib/key-parser.ts` decrypts the chosen credential; `lib/proxy.ts` builds the
   upstream request (undici pooling, SOCKS proxy support, SSE pass-through).
3. `providers/base.ts` + `providers/*` adapters translate wire formats for ~87
   providers; `openai-compat.ts` and `google.ts` are the largest.
4. On 429/5xx/timeout: `services/ratelimit.ts` applies cooldowns,
   `services/health.ts` marks the key, penalties are recorded, and the loop
   retries the next key/model. Hedge/TTFB budget logic can fire a backup early.
5. Analytics, request attempts, usage/token accounting and logs are written
   asynchronously; the response (including streaming SSE) is returned unbuffered.

Cache (`services/cache.ts`) is an in-memory LRU persisted to SQLite; idempotency
claims (`services/idempotency.ts`) dedupe retries. Compression
(`services/compression/*`) is opt-in per request/profile.

## 5. Key health, quotas and reliability

- `services/health.ts`: background checker, per-key status (`healthy|unknown|
  invalid|error`), proof-of-health, cooldown probe, round-robin across providers.
- `services/provider-quota.ts`, `quota-forecast.ts`, `quota-outlook.ts`: provider-reported
  quota snapshots, daily/monthly headroom, low-balance warnings, ~80% switch-ahead.
- `services/ratelimit.ts`: per-(platform, model, key) cooldowns with expiry, RPM/TPM
  and daily caps; persisted in `rate_limit_cooldowns`.
- `services/scoring.ts` + `router.ts`: decay-weighted reliability/speed from
  analytics, explicit failure penalties that decay over time.
- `services/degradation.ts`, `model-retirement.ts`: degraded mode and retired-model handling.

## 6. Data layer (`server/src/db/`)

- `index.ts` opens `better-sqlite3` (or Node's built-in sqlite on Android), sets
  **journal_mode = WAL**, `foreign_keys = ON`, `busy_timeout = 5000`, restricts
  file/dir permissions. `getDb()` is the singleton.
- `migrate/runner.ts` + `migrate/defaults.ts` hold an ordered, idempotent migration
  registry; `migrations/*` are additive and guarded with `hasColumn`/`hasTable`.
  `db:migration:{up,down,fresh,status,create}` are the CLI scripts.
- `lib/crypto.ts` owns the ENCRYPTION_KEY, AES-GCM encryption of provider keys,
  and decryptability probes. Dashboard passwords and setup/reset codes use
  scrypt-style hashing in `lib/password.ts`, `one-time-code.ts`, `setup-code.ts`.

## 7. Auth model

- **Unified key** (`getUnifiedApiKey()`): full inference access, never admin.
- **Client-profile key** `sk-cp-*` (`routes/client-profiles.ts`, `lib/system-prompt.ts`):
  stored as SHA-256 + encrypted copy, injects a server-enforced system prompt.
- **URL tokens** (`routes/url-tokens.ts`): revocable tokens for header-less clients.
- Dashboard session: email/password login with throttling and one-time reset code.
- All credential comparisons for inference are constant-time.

## 8. Dashboard (`client/src/`)

`App.tsx` defines routes; pages are in `pages/*`, shared widgets in
`components/*`, API wrapper in `lib/api.ts`. Keys page manages providers/keys;
Models page manages catalog + budgets; Playground streams from `/v1`; Analytics,
Fallback, Profiles pages drive the corresponding admin APIs. Styles are plain
CSS; i18n lives in `i18n/locales`.

## 9. Ops notes for this fork

- Public exposure must require auth. Use `TRUST_PROXY`, `ALLOWED_HOSTS`,
  `DASHBOARD_ORIGINS` and a tunnel mode when publishing; see `TUNNEL.md`.
- `/health` and `/metrics` are the unauthenticated liveness/metrics surfaces;
  `/livez` and `/readyz` remain for load balancers.
- Never commit secrets. `.env` / SQLite only. Provider keys are encrypted at rest.

## 10. License & credit

MIT. Original work Copyright (c) 2026 Tashfeen Ahmed. All upstream license headers,
the `LICENSE` file, and contributor credit are retained unchanged in this fork.
Fork-specific additions are distributed under the same MIT terms.
