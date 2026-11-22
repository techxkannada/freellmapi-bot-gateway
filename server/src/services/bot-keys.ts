// Bot virtual keys (`sk-bot-...`).
//
// Three pieces live here:
//   1. CRUD for operator-created bot credentials (admin API + dashboard).
//   2. Admission-time quota checks: RPM and TPM from in-memory sliding windows,
//      daily quota from a SQLite bucket that survives restarts.
//   3. Usage accounting and per-bot stats.
//
// The plaintext key is returned exactly once at creation/rotation. The DB holds
// only a SHA-256 digest for lookup plus an AES-GCM copy for masked display —
// the same split the client-profile keys use (lib/system-prompt.ts).

import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';

export const BOT_KEY_PREFIX = 'sk-bot-';

export interface BotIdentity {
  id: number;
  name: string;
  priority: number;
  concurrency: number;
  rpmLimit: number;
  tpmLimit: number;
  dailyLimit: number;
  allowedModels: string[] | null;
  routingStrategy: string | null;
}

export interface BotRow extends BotIdentity {
  maskedKey: string;
  enabled: boolean;
  requestCount: number;
  tokenCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawBotRow {
  id: number;
  name: string;
  token_hash: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  enabled: number;
  rpm_limit: number;
  tpm_limit: number;
  daily_limit: number;
  priority: number;
  concurrency: number;
  allowed_models: string | null;
  routing_strategy: string | null;
  request_count: number;
  token_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotCreateInput {
  name: string;
  rpmLimit?: number;
  tpmLimit?: number;
  dailyLimit?: number;
  priority?: number;
  concurrency?: number;
  allowedModels?: string[] | null;
  routingStrategy?: string | null;
}

export interface BotUpdateInput extends Partial<BotCreateInput> {
  enabled?: boolean;
}

export function mintBotKey(): string {
  return `${BOT_KEY_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
}

export function hashBotKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function masked(row: Pick<RawBotRow, 'encrypted_key' | 'iv' | 'auth_tag'>): string {
  try {
    return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return '[decrypt failed]';
  }
}

function toRow(row: RawBotRow): BotRow {
  let models: string[] | null = null;
  if (row.allowed_models) {
    try {
      const parsed = JSON.parse(row.allowed_models);
      if (Array.isArray(parsed)) models = parsed.filter((m): m is string => typeof m === 'string');
    } catch { /* malformed legacy value: treat as unrestricted */ }
  }
  return {
    id: row.id,
    name: row.name,
    maskedKey: masked(row),
    enabled: row.enabled === 1,
    requestCount: row.request_count,
    tokenCount: row.token_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    priority: row.priority,
    concurrency: row.concurrency,
    rpmLimit: row.rpm_limit,
    tpmLimit: row.tpm_limit,
    dailyLimit: row.daily_limit,
    allowedModels: models,
    routingStrategy: row.routing_strategy,
  };
}

function getRaw(id: number): RawBotRow | undefined {
  return getDb().prepare('SELECT * FROM bot_keys WHERE id = ?').get(id) as RawBotRow | undefined;
}

export function listBots(): BotRow[] {
  const rows = getDb().prepare('SELECT * FROM bot_keys ORDER BY priority DESC, id ASC').all() as RawBotRow[];
  return rows.map(toRow);
}

export function getBot(id: number): BotRow | null {
  const row = getRaw(id);
  return row ? toRow(row) : null;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function createBot(input: BotCreateInput): { bot: BotRow; key: string } {
  const key = mintBotKey();
  const secret = encrypt(key);
  const result = getDb().prepare(`
    INSERT INTO bot_keys
      (name, token_hash, encrypted_key, iv, auth_tag, enabled, rpm_limit, tpm_limit,
       daily_limit, priority, concurrency, allowed_models, routing_strategy)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    hashBotKey(key),
    secret.encrypted,
    secret.iv,
    secret.authTag,
    clamp(input.rpmLimit, 60, 1, 100000),
    clamp(input.tpmLimit, 100000, 1, 100000000),
    clamp(input.dailyLimit, 1000, 1, 100000000),
    clamp(input.priority, 5, 0, 100),
    clamp(input.concurrency, 2, 1, 128),
    input.allowedModels && input.allowedModels.length > 0 ? JSON.stringify(input.allowedModels) : null,
    input.routingStrategy ?? null,
  );
  const bot = getBot(Number(result.lastInsertRowid));
  if (!bot) throw new Error('Failed to create bot key');
  return { bot, key };
}

export function updateBot(id: number, patch: BotUpdateInput): BotRow | null {
  if (!getRaw(id)) return null;
  const sets: string[] = [];
  const values: unknown[] = [];
  const simple: Array<[keyof BotUpdateInput, string]> = [
    ['name', 'name'],
    ['rpmLimit', 'rpm_limit'],
    ['tpmLimit', 'tpm_limit'],
    ['dailyLimit', 'daily_limit'],
    ['priority', 'priority'],
    ['concurrency', 'concurrency'],
    ['routingStrategy', 'routing_strategy'],
  ];
  for (const [field, column] of simple) {
    if (patch[field] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(patch[field]);
  }
  if (patch.allowedModels !== undefined) {
    sets.push('allowed_models = ?');
    values.push(patch.allowedModels && patch.allowedModels.length > 0 ? JSON.stringify(patch.allowedModels) : null);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return getBot(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  getDb().prepare(`UPDATE bot_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getBot(id);
}

export function deleteBot(id: number): boolean {
  return getDb().prepare('DELETE FROM bot_keys WHERE id = ?').run(id).changes > 0;
}

export function rotateBotKey(id: number): { bot: BotRow; key: string } | null {
  const row = getRaw(id);
  if (!row) return null;
  const key = mintBotKey();
  const secret = encrypt(key);
  getDb().prepare(`
    UPDATE bot_keys SET token_hash = ?, encrypted_key = ?, iv = ?, auth_tag = ?,
      updated_at = datetime('now') WHERE id = ?
  `).run(hashBotKey(key), secret.encrypted, secret.iv, secret.authTag, id);
  forgetQuota(id);
  return { bot: getBot(id)!, key };
}

/** Resolve a presented `sk-bot-` token to its identity. Never reveals the key. */
export function getBotByToken(token: string | undefined): BotIdentity | null {
  if (!token || !token.startsWith(BOT_KEY_PREFIX)) return null;
  const row = getDb().prepare(
    'SELECT * FROM bot_keys WHERE token_hash = ? AND enabled = 1',
  ).get(hashBotKey(token)) as RawBotRow | undefined;
  if (!row) return null;
  let models: string[] | null = null;
  if (row.allowed_models) {
    try {
      const parsed = JSON.parse(row.allowed_models);
      if (Array.isArray(parsed)) models = parsed.filter((m): m is string => typeof m === 'string');
    } catch { /* treat as unrestricted */ }
  }
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    concurrency: row.concurrency,
    rpmLimit: row.rpm_limit,
    tpmLimit: row.tpm_limit,
    dailyLimit: row.daily_limit,
    allowedModels: models,
    routingStrategy: row.routing_strategy,
  };
}

// ── In-memory hot quota state ────────────────────────────────────────────────
//
// RPM/TPM are deliberately in-process: a restart resets the short window,
// which is what an operator expects, while the daily cap lives in SQLite and
// survives it. Each bot gets two small arrays; expired entries are pruned on
// every check, so a long-lived gateway does not grow without bound.

interface Window { times: number[]; tokens: Array<{ t: number; n: number }> }
const windows = new Map<number, Window>();
const WINDOW_MS = 60_000;

function windowFor(id: number): Window {
  let w = windows.get(id);
  if (!w) {
    w = { times: [], tokens: [] };
    windows.set(id, w);
  }
  return w;
}

export function forgetQuota(id: number): void {
  windows.delete(id);
}

function prune(now: number): void {
  if (windows.size > 2000) {
    for (const [id, w] of windows) {
      if (w.times.length === 0 && w.tokens.length === 0) windows.delete(id);
    }
  }
  for (const w of windows.values()) {
    while (w.times.length > 0 && w.times[0]! <= now - WINDOW_MS) w.times.shift();
    while (w.tokens.length > 0 && w.tokens[0]!.t <= now - WINDOW_MS) w.tokens.shift();
  }
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: 'rpm' | 'tpm' | 'daily' | 'disabled';
  retryAfterSeconds?: number;
}

/** Check and RESERVE one request against the bot's quotas. */
export function checkBotQuota(bot: BotIdentity): QuotaDecision {
  const now = Date.now();
  prune(now);
  const w = windowFor(bot.id);

  if (w.times.length >= bot.rpmLimit) {
    return { allowed: false, reason: 'rpm', retryAfterSeconds: Math.max(1, Math.ceil((w.times[0]! + WINDOW_MS - now) / 1000)) };
  }
  const usedTpm = w.tokens.reduce((sum, entry) => sum + entry.n, 0);
  if (usedTpm >= bot.tpmLimit) {
    return { allowed: false, reason: 'tpm', retryAfterSeconds: Math.max(1, Math.ceil((w.tokens[0]!.t + WINDOW_MS - now) / 1000)) };
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const daily = getDb().prepare(
    'SELECT requests FROM bot_usage WHERE bot_id = ? AND day = ?',
  ).get(bot.id, day) as { requests: number } | undefined;
  if ((daily?.requests ?? 0) >= bot.dailyLimit) {
    const nextReset = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
    return { allowed: false, reason: 'daily', retryAfterSeconds: Math.max(1, Math.ceil((nextReset - now) / 1000)) };
  }

  w.times.push(now);
  return { allowed: true };
}

/** Account completed (or failed) usage against the daily bucket and totals. */
export function recordBotUsage(botId: number, tokens: number): void {
  const now = Date.now();
  const w = windowFor(botId);
  if (tokens > 0) w.tokens.push({ t: now, n: Math.floor(tokens) });
  const day = new Date(now).toISOString().slice(0, 10);
  getDb().prepare(`
    INSERT INTO bot_usage (bot_id, day, requests, tokens) VALUES (?, ?, 1, ?)
    ON CONFLICT(bot_id, day) DO UPDATE SET
      requests = requests + 1,
      tokens = tokens + excluded.tokens
  `).run(botId, day, Math.max(0, Math.floor(tokens || 0)));
  getDb().prepare(`
    UPDATE bot_keys SET request_count = request_count + 1,
      token_count = token_count + ?, last_used_at = datetime('now'),
      updated_at = datetime('now') WHERE id = ?
  `).run(Math.max(0, Math.floor(tokens || 0)), botId);
}

/** TPM reservation made at admission, consumed once the token count is known. */
export function reserveBotTokens(botId: number, estimate: number): void {
  if (estimate > 0) windowFor(botId).tokens.push({ t: Date.now(), n: Math.floor(estimate) });
}

export function botUsageStats(id: number, days = 7): {
  totals: { requests: number; tokens: number };
  daily: Array<{ day: string; requests: number; tokens: number }>;
} {
  const row = getDb().prepare(
    'SELECT request_count AS requests, token_count AS tokens FROM bot_keys WHERE id = ?',
  ).get(id) as { requests: number; tokens: number } | undefined;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const daily = getDb().prepare(
    'SELECT day, requests, tokens FROM bot_usage WHERE bot_id = ? AND day >= ? ORDER BY day DESC',
  ).all(id, since) as Array<{ day: string; requests: number; tokens: number }>;
  return { totals: row ?? { requests: 0, tokens: 0 }, daily };
}
