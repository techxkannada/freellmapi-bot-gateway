// Priority request queue with concurrency limits.
//
// Bots share one gateway, so without admission control a burst from one bot can
// saturate every provider key and starve the others. This queue gives each bot
// its own concurrency budget (from its virtual key), a global ceiling for the
// process, and priority ordering. Wait time ages a request's effective priority
// so a busy high-priority bot cannot starve a low-priority one forever.
//
// The acquire() promise resolves with a release function; callers MUST release
// on response finish/close (the middleware does). No timers are left behind on
// the hot path: the only setTimeout is the waiter's own admission deadline.

import { recordQueueEnqueued, recordQueueRejected, setQueueDepth, setInFlight } from './metrics.js';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

const GLOBAL_LIMIT = envInt('BOT_QUEUE_CONCURRENCY', 64, 1, 4096);
const MAX_DEPTH = envInt('BOT_QUEUE_MAX_DEPTH', 512, 1, 100000);
const TIMEOUT_MS = envInt('BOT_QUEUE_TIMEOUT_MS', 30_000, 1000, 600_000);
const AGING_MS = 2000; // +1 effective priority for every 2s waited

interface Waiter {
  key: string;
  priority: number;
  limit: number;
  seq: number;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let seq = 0;
const waiting: Waiter[] = [];
const activeByKey = new Map<string, number>();
let activeTotal = 0;
let enqueued = 0;
let rejected = 0;
let timedOut = 0;

export class QueueFullError extends Error {
  constructor(message = 'Request queue is full') {
    super(message);
    this.name = 'QueueFullError';
  }
}
export class QueueTimeoutError extends Error {
  constructor(message = 'Timed out waiting for a concurrency slot') {
    super(message);
    this.name = 'QueueTimeoutError';
  }
}

function makeRelease(key: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTotal = Math.max(0, activeTotal - 1);
    const n = (activeByKey.get(key) ?? 1) - 1;
    if (n <= 0) activeByKey.delete(key);
    else activeByKey.set(key, n);
    setInFlight(activeTotal);
    drain();
  };
}

function grant(waiter: Waiter): void {
  clearTimeout(waiter.timer);
  activeTotal++;
  activeByKey.set(waiter.key, (activeByKey.get(waiter.key) ?? 0) + 1);
  setInFlight(activeTotal);
  setQueueDepth(waiting.length);
  waiter.resolve(makeRelease(waiter.key));
}

function canGrant(waiter: Waiter): boolean {
  return activeTotal < GLOBAL_LIMIT && (activeByKey.get(waiter.key) ?? 0) < waiter.limit;
}

function drain(): void {
  if (waiting.length === 0) return;
  const now = Date.now();
  waiting.sort((a, b) => {
    const ageA = a.priority + Math.floor((now - a.enqueuedAt) / AGING_MS);
    const ageB = b.priority + Math.floor((now - b.enqueuedAt) / AGING_MS);
    return ageB - ageA || a.seq - b.seq;
  });
  for (let i = waiting.length - 1; i >= 0; i--) {
    const waiter = waiting[i]!;
    if (!canGrant(waiter)) continue;
    waiting.splice(i, 1);
    grant(waiter);
  }
  setQueueDepth(waiting.length);
}

export interface AcquireOptions {
  /** Concurrency bucket — use the bot id, so one bot cannot starve the rest. */
  key: string;
  /** Higher priority is served first (after aging). */
  priority: number;
  /** Per-bucket concurrency ceiling. */
  limit: number;
}

export function acquireSlot(options: AcquireOptions): Promise<() => void> {
  const waiterBase = {
    key: options.key,
    priority: Math.min(100, Math.max(0, Math.floor(options.priority || 0))),
    limit: Math.min(128, Math.max(1, Math.floor(options.limit || 1))),
  };

  if (activeTotal < GLOBAL_LIMIT && (activeByKey.get(waiterBase.key) ?? 0) < waiterBase.limit) {
    activeTotal++;
    activeByKey.set(waiterBase.key, (activeByKey.get(waiterBase.key) ?? 0) + 1);
    setInFlight(activeTotal);
    return Promise.resolve(makeRelease(waiterBase.key));
  }

  if (waiting.length >= MAX_DEPTH) {
    rejected++;
    recordQueueRejected();
    return Promise.reject(new QueueFullError());
  }

  enqueued++;
  recordQueueEnqueued();
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      ...waiterBase,
      seq: ++seq,
      enqueuedAt: Date.now(),
      resolve,
      reject,
      timer: setTimeout(() => {
        const at = waiting.indexOf(waiter);
        if (at !== -1) {
          waiting.splice(at, 1);
          timedOut++;
          setQueueDepth(waiting.length);
          reject(new QueueTimeoutError());
        }
      }, TIMEOUT_MS),
    };
    waiter.timer.unref?.();
    waiting.push(waiter);
    setQueueDepth(waiting.length);
    drain();
  });
}

export function queueStats() {
  return {
    depth: waiting.length,
    active: activeTotal,
    by_key: Object.fromEntries(activeByKey),
    enqueued,
    rejected,
    timed_out: timedOut,
    global_limit: GLOBAL_LIMIT,
    max_depth: MAX_DEPTH,
    timeout_ms: TIMEOUT_MS,
  };
}

/** Test-only: drop all queued waiters and reset counters. */
export function resetQueue(): void {
  for (const w of waiting) {
    clearTimeout(w.timer);
    w.reject(new QueueTimeoutError());
  }
  waiting.length = 0;
  activeByKey.clear();
  activeTotal = 0;
  enqueued = 0;
  rejected = 0;
  timedOut = 0;
  setQueueDepth(0);
  setInFlight(0);
}
