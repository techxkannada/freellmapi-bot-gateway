import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import {
  getRoutingStrategy,
  setRoutingStrategy,
  getActiveRoutingWeights,
  effectiveKeySelectionStrategy,
  setKeySelectionStrategy,
} from '../../services/router.js';
import { MODEL_ALIASES, isModelAlias, normalizeModelAlias } from '../../services/model-aliases.js';
import { BANDIT_PRESETS } from '../../services/scoring.js';

async function models(app: Express) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/models`, {
    headers: { authorization: `Bearer ${getUnifiedApiKey()}` },
  });
  const body = await res.json();
  server.close();
  return { status: res.status, body };
}

describe('operator routing strategies', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setKeySelectionStrategy('auto');
  });

  afterAll(() => {
    setRoutingStrategy('balanced');
    setKeySelectionStrategy('auto');
  });

  it('round-robin: pure key rotation, model ranking unchanged', () => {
    setRoutingStrategy('round-robin');
    expect(getRoutingStrategy()).toBe('round-robin');
    expect(effectiveKeySelectionStrategy()).toBe('round-robin');
    expect(getActiveRoutingWeights().weights).toEqual(BANDIT_PRESETS.balanced);
  });

  it('least-used: fewest-requests key first, balanced model ranking', () => {
    setRoutingStrategy('least-used');
    expect(effectiveKeySelectionStrategy()).toBe('least-used');
    expect(getActiveRoutingWeights().weights).toEqual(BANDIT_PRESETS.balanced);
  });

  it('lowest-latency: fastest key first, fastest model weighting', () => {
    setRoutingStrategy('lowest-latency');
    expect(effectiveKeySelectionStrategy()).toBe('lowest-latency');
    expect(getActiveRoutingWeights().weights).toEqual(BANDIT_PRESETS.fastest);
  });

  it('an explicit key policy wins only when the strategy does not imply one', () => {
    setRoutingStrategy('balanced');
    setKeySelectionStrategy('least-remaining');
    expect(effectiveKeySelectionStrategy()).toBe('least-remaining');
    setRoutingStrategy('round-robin');
    expect(effectiveKeySelectionStrategy()).toBe('round-robin');
  });

  it('rejects unknown strategies', () => {
    expect(() => setRoutingStrategy('magic' as never)).toThrow(/Unknown routing strategy/);
  });
});

describe('model aliases', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('normalizes case and rejects unknown names', () => {
    expect(isModelAlias('FAST')).toBe(true);
    expect(normalizeModelAlias('  Smart ')).toBe('smart');
    expect(isModelAlias('gpt-4')).toBe(false);
    expect(normalizeModelAlias(undefined)).toBeNull();
  });

  it('maps each alias to a preset and exposes all four through /v1/models', async () => {
    expect(MODEL_ALIASES).toMatchObject({ auto: 'balanced', fast: 'fastest', smart: 'smartest', coding: 'smartest' });
    const app = createApp();
    const { status, body } = await models(app);
    expect(status).toBe(200);
    const ids = body.data.map((m: { id: string }) => m.id);
    for (const id of ['auto', 'fast', 'smart', 'coding']) expect(ids).toContain(id);
    const fast = body.data.find((m: { id: string }) => m.id === 'fast');
    expect(fast.routing_strategy).toBe('fastest');
    expect(body.data.filter((m: { id: string }) => m.id === 'auto').length).toBe(1);
  });
});
