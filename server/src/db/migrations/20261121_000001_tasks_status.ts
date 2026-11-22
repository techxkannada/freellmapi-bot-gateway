// Migration: add tasks table with status column
// Created: 2026-11-21
//
// DOWN: reversible (DROP TABLE)
//
// Adds a tasks table to track task progress with status tracking.
//
// The status column uses values: 'pending' | 'in_progress' | 'done' (default 'pending')
// This enables tracking task progress throughout the system.
//
// Guarded like every other schema change: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

export const filename = '20261121_000001_tasks_status.ts';

import type { Db } from '../types.js';

function hasTable(db: Db, table: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`
  ).all();
  return result.length > 0;
}

export function up(db: Db): void {
  if (!hasTable(db, 'tasks')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    `);
  }
}

export function down(db: Db): void {
  if (hasTable(db, 'tasks')) {
    db.prepare('DROP INDEX IF EXISTS idx_tasks_status').run();
    db.prepare('DROP INDEX IF EXISTS idx_tasks_created_at').run();
    db.prepare('DROP TABLE tasks').run();
  }
}