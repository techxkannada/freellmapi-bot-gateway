import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import {
  applyAutoSwitch,
  getAutoSwitchConfig,
  setAutoSwitchConfig,
} from '../../services/auto-switch.js';
import { getHeadroomThresholds, getKeySelectionStrategy } from '../../services/router.js';
import { mintDashboardToken } from '../helpers/auth.js';

describe('fast auto-switch configuration', () => {
  let app: Express;
  let dash: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.AUTO_FAST_SWITCH;
    delete process.env.AUTO_SWITCH_QUOTA_PCT;
    delete process.env.AUTO_SWITCH_HEDGE_MS;
    delete process.env.FALLBACK_TIME_BUDGET_MS;
    delete process.env.KEY_SELECTION_STRATEGY;
    initDb(':memory:');
    app = createApp();
    dash = mintDashboardToken();
  });

  afterAll(() => {
    setAutoSwitchConfig({ enabled: false, quotaSwitchPct: 80, hedgeTimeoutMs: 8000 });
    delete process.env.FALLBACK_TIME_BUDGET_MS;
  });

  it('defaults to off with 80% quota and 8s hedge', () => {
    expect(getAutoSwitchConfig()).toMatchObject({ enabled: false, quotaSwitchPct: 80, hedgeTimeoutMs: 8000 });
  });

  it('applies quota headroom, hedge budget and lowest-latency key policy', () => {
    const cfg = applyAutoSwitch();
    expect(cfg.enabled).toBe(false);
    setAutoSwitchConfig({ enabled: true, quotaSwitchPct: 70, hedgeTimeoutMs: 6000 });
    applyAutoSwitch();
    expect(getHeadroomThresholds().rampStart).toBeCloseTo(0.3, 3);
    expect(process.env.FALLBACK_TIME_BUDGET_MS).toBe('6000');
    expect(getKeySelectionStrategy()).toBe('lowest-latency');
  });

  it('exposes GET/PUT /api/settings/auto-switch behind dashboard auth', async () => {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(r => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const call = (method: string, body?: unknown) => fetch(`http://127.0.0.1:${port}/api/settings/auto-switch`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${dash}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const unauth = await fetch(`http://127.0.0.1:${port}/api/settings/auto-switch`);
    expect(unauth.status).toBe(401);

    const get = await call('GET');
    const body = await get.json() as { enabled: boolean; quotaSwitchPct: number };
    expect(get.status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.quotaSwitchPct).toBe(70);

    const bad = await call('PUT', { quotaSwitchPct: 150 });
    expect(bad.status).toBe(400);
    const put = await call('PUT', { enabled: true, quotaSwitchPct: 60, hedgeTimeoutMs: 4000 });
    expect(put.status).toBe(200);
    expect(getAutoSwitchConfig().quotaSwitchPct).toBe(60);
    expect(process.env.FALLBACK_TIME_BUDGET_MS).toBe('4000');
    server.close();
  });

  it('keeps the unified inference key unrelated to the setting', () => {
    expect(getUnifiedApiKey().startsWith('freellmapi-')).toBe(true);
  });
});
