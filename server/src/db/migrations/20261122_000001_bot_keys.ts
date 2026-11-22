// Migration: per-bot virtual keys (`sk-bot-...`) with quotas and usage.
// Created: 2026-11-22
//
// DOWN: reversible (DROP TABLE)
//
// A bot key is a third kind of inference credential, separate from the unified
// key and the `sk-cp-` client-profile key. It authenticates ONLY the inference
// surfaces and carries its own RPM/TPM/daily caps, priority and concurrency
// budget. token_hash is the SHA-256 of the full secret — the plaintext is never
// queryable; the encrypted copy exists solely so the admin API can show a
// masked form. Usage rolls up into daily buckets for quota enforcement and
// lifetime totals for stats.

import type { Db } from '../types.js';

export const filename = '20261122_000001_bot_keys.ts';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      rpm_limit INTEGER NOT NULL DEFAULT 60,
      tpm_limit INTEGER NOT NULL DEFAULT 100000,
      daily_limit INTEGER NOT NULL DEFAULT 1000,
      priority INTEGER NOT NULL DEFAULT 5,
      concurrency INTEGER NOT NULL DEFAULT 2,
      allowed_models TEXT,
      routing_strategy TEXT,
      request_count INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_usage (
      bot_id INTEGER NOT NULL REFERENCES bot_keys(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bot_id, day)
    );

    CREATE INDEX IF NOT EXISTS idx_bot_usage_day ON bot_usage(day);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS bot_usage; DROP TABLE IF EXISTS bot_keys;');
}
