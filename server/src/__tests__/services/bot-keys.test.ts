import { beforeAll, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import {
  BOT_KEY_PREFIX,
  botUsageStats,
  checkBotQuota,
  createBot,
  deleteBot,
  forgetQuota,
  getBotByToken,
  hashBotKey,
  recordBotUsage,
  rotateBotKey,
  updateBot,
} from '../../services/bot-keys.js';

describe('bot virtual keys: storage, quota and usage', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('creates a key that authenticates by hash only, never by plaintext', () => {
    const { bot, key } = createBot({ name: 'alice-bot', rpmLimit: 3, dailyLimit: 5 });
    expect(key.startsWith(BOT_KEY_PREFIX)).toBe(true);

    const row = getDb().prepare('SELECT * FROM bot_keys WHERE id = ?').get(bot.id) as {
      token_hash: string; encrypted_key: string; iv: string; auth_tag: string;
    };
    expect(row.token_hash).toBe(hashBotKey(key));
    expect(row.token_hash).not.toContain(key);
    expect(decrypt(row.encrypted_key, row.iv, row.auth_tag)).toBe(key);

    const identity = getBotByToken(key);
    expect(identity?.name).toBe('alice-bot');
    expect(identity?.rpmLimit).toBe(3);
    expect(getBotByToken(key.slice(0, -1) + 'x')).toBeNull();
  });

  it('enforces RPM from in-memory hot state with a retry hint', () => {
    const { bot, key } = createBot({ name: 'rpm-bot', rpmLimit: 2, dailyLimit: 100 });
    const identity = getBotByToken(key)!;
    expect(checkBotQuota(identity).allowed).toBe(true);
    expect(checkBotQuota(identity).allowed).toBe(true);
    const third = checkBotQuota(identity);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('rpm');
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
    forgetQuota(bot.id);
    expect(checkBotQuota(identity).allowed).toBe(true);
  });

  it('enforces the daily quota from the persisted bucket and tracks usage', () => {
    const { bot, key } = createBot({ name: 'daily-bot', rpmLimit: 100, dailyLimit: 2 });
    const identity = getBotByToken(key)!;
    recordBotUsage(bot.id, 40);
    expect(checkBotQuota(identity).allowed).toBe(true);
    recordBotUsage(bot.id, 60);
    const blocked = checkBotQuota(identity);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('daily');

    const stats = botUsageStats(bot.id);
    expect(stats.totals.requests).toBe(2);
    expect(stats.totals.tokens).toBe(100);
    expect(stats.daily[0]?.tokens).toBe(100);
  });

  it('rotation invalidates the old key; disable and delete are final', () => {
    const { bot, key } = createBot({ name: 'rotate-bot' });
    const rotated = rotateBotKey(bot.id)!;
    expect(rotated.key).not.toBe(key);
    expect(getBotByToken(key)).toBeNull();
    expect(getBotByToken(rotated.key)?.id).toBe(bot.id);

    updateBot(bot.id, { enabled: false });
    expect(getBotByToken(rotated.key)).toBeNull();
    updateBot(bot.id, { enabled: true });
    expect(deleteBot(bot.id)).toBe(true);
    expect(getBotByToken(rotated.key)).toBeNull();
  });
});
