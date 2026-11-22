// Four short model aliases for bots and automation clients. They are router
// directives, not catalog models: the request is routed through the normal
// `auto` chain with a request-scoped preset bias. That means every alias keeps
// the full failover ladder, key health checks and quota gates — an alias is
// never a second, weaker routing path.
//
//   auto   → balanced   (default "best available")
//   fast   → fastest    (TTFB/throughput-led)
//   smart  → smartest   (quality-led)
//   coding → smartest + code task bias (tool-aware, quality-led)

import type { PresetStrategy } from './scoring.js';
import { setRequestRoutingStrategy } from '../lib/client-context.js';

export const MODEL_ALIASES = {
  auto: 'balanced',
  fast: 'fastest',
  smart: 'smartest',
  coding: 'smartest',
} as const satisfies Record<string, PresetStrategy>;

export type ModelAlias = keyof typeof MODEL_ALIASES;

const ALIAS_KEYS = Object.keys(MODEL_ALIASES) as ModelAlias[];

export function isModelAlias(value: string | undefined): value is ModelAlias {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return (ALIAS_KEYS as string[]).includes(lower);
}

export function normalizeModelAlias(value: string | undefined): ModelAlias | null {
  if (!isModelAlias(value)) return null;
  return value!.trim().toLowerCase() as ModelAlias;
}

/** Apply the alias's preset bias to THIS request. No-op outside a request. */
export function applyModelAlias(value: string | undefined): ModelAlias | null {
  const alias = normalizeModelAlias(value);
  if (alias) setRequestRoutingStrategy(MODEL_ALIASES[alias]);
  return alias;
}

export interface ModelAliasEntry {
  id: ModelAlias;
  name: string;
  owned_by: 'freellmapi';
  strategy: PresetStrategy;
}

export function modelAliasEntries(): ModelAliasEntry[] {
  const names: Record<ModelAlias, string> = {
    auto: 'Auto (router picks the best available model)',
    fast: 'Fast (lowest latency, unaffected by model size)',
    smart: 'Smart (highest quality available)',
    coding: 'Coding (quality-led, tool and code aware)',
  };
  return ALIAS_KEYS.map(id => ({
    id,
    name: names[id],
    owned_by: 'freellmapi' as const,
    strategy: MODEL_ALIASES[id],
  }));
}
