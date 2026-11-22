// Bot-key admission middleware, mounted on every inference surface.
//
// A `sk-bot-` credential gets three things before it reaches a router:
//   1. Identity resolution (disabled/deleted keys are rejected exactly like
//      unknown ones — no oracle for "this bot exists but is off").
//   2. RPM/TPM/daily quota enforcement with Retry-After on 429.
//   3. A concurrency slot in the priority queue, released on response end.
//
// Non-bot credentials pass straight through: the unified key and `sk-cp-`
// client-profile keys keep their existing behavior and budgets.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { extractApiToken } from '../routes/proxy.js';
import { BOT_KEY_PREFIX, checkBotQuota, getBotByToken, recordBotUsage, type BotIdentity } from '../services/bot-keys.js';
import { QueueFullError, QueueTimeoutError, acquireSlot } from '../services/bot-queue.js';
import { recordBotRequest, recordBotTokens, recordRateLimit } from '../services/metrics.js';
import { setRequestRoutingStrategy } from '../lib/client-context.js';
import type { PresetStrategy } from '../services/scoring.js';

export interface BotRequestContext {
  bot: BotIdentity;
  release: () => void;
}

export type BotRequest = Request & { botContext?: BotRequestContext };

const VALID_STRATEGIES = new Set<PresetStrategy>(['balanced', 'smartest', 'fastest', 'reliable']);

function modelOf(req: Request): string | undefined {
  const body = req.body as { model?: unknown } | undefined;
  return typeof body?.model === 'string' ? body.model : undefined;
}

function error(res: Response, status: number, message: string, type = 'rate_limit_error'): void {
  res.status(status).json({ error: { message, type } });
}

export function createBotGuard(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractApiToken(req);
    if (!token || !token.startsWith(BOT_KEY_PREFIX)) {
      next();
      return;
    }

    const bot = getBotByToken(token);
    if (!bot) {
      error(res, 401, 'Invalid bot API key', 'authentication_error');
      return;
    }

    const model = modelOf(req);
    if (model && bot.allowedModels && !bot.allowedModels.includes(model)) {
      error(res, 403, `Bot '${bot.name}' is not allowed to use model '${model}'`, 'permission_error');
      return;
    }

    const decision = checkBotQuota(bot);
    if (!decision.allowed) {
      if (decision.retryAfterSeconds) res.set('Retry-After', String(decision.retryAfterSeconds));
      recordRateLimit();
      error(res, 429, `Bot quota exceeded (${decision.reason ?? 'limit'})`);
      return;
    }

    let release: () => void;
    try {
      release = await acquireSlot({
        key: `bot:${bot.id}`,
        priority: bot.priority,
        limit: bot.concurrency,
      });
    } catch (err) {
      res.set('Retry-After', err instanceof QueueTimeoutError ? '1' : '5');
      error(res, err instanceof QueueFullError ? 503 : 504,
        err instanceof QueueFullError ? 'Gateway request queue is full' : 'Timed out waiting for a request slot',
        'overload_error');
      return;
    }

    if (bot.routingStrategy && VALID_STRATEGIES.has(bot.routingStrategy as PresetStrategy)) {
      setRequestRoutingStrategy(bot.routingStrategy as PresetStrategy);
    }

    // Count bytes at the transport boundary. Token usage is estimated at
    // ~4 bytes/token (the same rule the router uses for prompt budgeting);
    // exact upstream usage is recorded separately by the analytics layer.
    let responseBytes = 0;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    (res as Response & { write(...args: any[]): boolean }).write = ((chunk: any, ...rest: any[]) => {
      if (typeof chunk === 'string') responseBytes += Buffer.byteLength(chunk);
      else if (Buffer.isBuffer(chunk)) responseBytes += chunk.length;
      return originalWrite(chunk, ...rest);
    }) as typeof res.write;
    (res as Response & { end(...args: any[]): Response }).end = ((chunk?: any, ...rest: any[]) => {
      if (typeof chunk === 'string') responseBytes += Buffer.byteLength(chunk);
      else if (Buffer.isBuffer(chunk)) responseBytes += chunk.length;
      return originalEnd(chunk, ...rest);
    }) as typeof res.end;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        const requestBytes = req.body ? JSON.stringify(req.body).length : 0;
        const tokens = Math.ceil((requestBytes + responseBytes) / 4);
        recordBotUsage(bot.id, tokens);
        recordBotRequest(bot.name);
        recordBotTokens(bot.name, tokens);
      } finally {
        release();
      }
    };
    res.once('finish', finish);
    res.once('close', finish);

    (req as BotRequest).botContext = { bot, release };
    next();
  };
}
