// One knob for "switch away from a slow or nearly-spent route sooner".
//
// The gateway already has every primitive: quota headroom demotion, the
// failover time budget (which arms the hedge/backup attempt), and key
// selection policies. This module applies a coherent set of defaults for bot
// installs that want faster automatic switching instead of tuning four
// unrelated settings by hand. Every value is still independently overridable
// by its own env var or dashboard setting.
//
//   AUTO_FAST_SWITCH=1        enable at boot (or PUT /api/settings/auto-switch)
//   AUTO_SWITCH_QUOTA_PCT=80  start avoiding a key once 80% of its quota is used
//   AUTO_SWITCH_HEDGE_MS=8000 arm the backup provider after 8s of silence

import { getDb, getSetting, setSetting } from '../db/index.js';
import { setHeadroomThresholds } from './router.js';
import { setKeySelectionStrategy } from './router.js';

export const AUTO_FAST_SWITCH_KEY = 'auto_fast_switch';
export const AUTO_SWITCH_QUOTA_KEY = 'auto_switch_quota_pct';
export const AUTO_SWITCH_HEDGE_KEY = 'auto_switch_hedge_ms';

export const DEFAULT_QUOTA_PCT = 80;
export const DEFAULT_HEDGE_MS = 8000;

// Snapshot once at import: after we apply the preset the env vars are set, and
// a later dashboard PUT must still be able to change them. An operator value
// present at boot is the one that stays authoritative.
const BOOT_ENV = {
  hedge: process.env.FALLBACK_TIME_BUDGET_MS,
  headroom: process.env.HEADROOM_RAMP_START,
  keySelection: process.env.KEY_SELECTION_STRATEGY,
};

export interface AutoSwitchConfig {
  enabled: boolean;
  quotaSwitchPct: number;
  hedgeTimeoutMs: number;
}

function num(raw: string | undefined | null, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export function getAutoSwitchConfig(): AutoSwitchConfig {
  return {
    enabled: getSetting(AUTO_FAST_SWITCH_KEY) === '1' || process.env.AUTO_FAST_SWITCH === '1',
    quotaSwitchPct: num(
      getSetting(AUTO_SWITCH_QUOTA_KEY) ?? process.env.AUTO_SWITCH_QUOTA_PCT,
      DEFAULT_QUOTA_PCT, 1, 99,
    ),
    hedgeTimeoutMs: num(
      getSetting(AUTO_SWITCH_HEDGE_KEY) ?? process.env.AUTO_SWITCH_HEDGE_MS,
      DEFAULT_HEDGE_MS, 500, 600_000,
    ),
  };
}

/** Persist a patch. Values are validated here as well as in the API schema so
 *  callers from other code paths cannot write an out-of-range setting. */
export function setAutoSwitchConfig(patch: Partial<AutoSwitchConfig>): AutoSwitchConfig {
  if (patch.enabled !== undefined) setSetting(AUTO_FAST_SWITCH_KEY, patch.enabled ? '1' : '0');
  if (patch.quotaSwitchPct !== undefined) {
    const n = num(String(patch.quotaSwitchPct), DEFAULT_QUOTA_PCT, 1, 99);
    setSetting(AUTO_SWITCH_QUOTA_KEY, String(n));
  }
  if (patch.hedgeTimeoutMs !== undefined) {
    const n = num(String(patch.hedgeTimeoutMs), DEFAULT_HEDGE_MS, 500, 600_000);
    setSetting(AUTO_SWITCH_HEDGE_KEY, String(n));
  }
  return getAutoSwitchConfig();
}

/** Apply the effective config to the underlying mechanisms. Env vars that the
 *  operator set explicitly always win over the fast-switch defaults. */
export function applyAutoSwitch(): AutoSwitchConfig {
  const cfg = getAutoSwitchConfig();
  if (!cfg.enabled) {
    // Turning the preset off restores the mechanism defaults (only for values
    // this module owns — an operator value present at boot is never touched).
    if (BOOT_ENV.headroom === undefined) setHeadroomThresholds(null);
    if (BOOT_ENV.hedge === undefined) delete process.env.FALLBACK_TIME_BUDGET_MS;
    if (BOOT_ENV.keySelection === undefined) setKeySelectionStrategy('auto');
    return cfg;
  }

  // Headroom guardrail works on REMAINING fraction: 80% used => 0.2 left.
  if (BOOT_ENV.headroom === undefined) {
    setHeadroomThresholds(+((100 - cfg.quotaSwitchPct) / 100).toFixed(3));
  }
  // Failover loop reads this env (or the fallback_time_budget_ms setting) when
  // arming the hedge timer. Set/refresh it so a later PUT takes effect too.
  if (BOOT_ENV.hedge === undefined) {
    process.env.FALLBACK_TIME_BUDGET_MS = String(cfg.hedgeTimeoutMs);
  }
  // Prefer the lowest-latency credential once a model has been chosen.
  if (BOOT_ENV.keySelection === undefined) {
    setKeySelectionStrategy('lowest-latency');
  }
  return cfg;
}

export function autoSwitchStatus() {
  const db = getDb();
  return {
    ...getAutoSwitchConfig(),
    effective: {
      headroomRampStart: getSetting('routing_headroom_ramp_start') ?? null,
      hedgeTimeoutMs: getSetting('fallback_time_budget_ms') ?? process.env.FALLBACK_TIME_BUDGET_MS ?? null,
      keySelectionStrategy: getSetting('key_selection_strategy') ?? null,
    },
    applied: db != null,
  };
}
