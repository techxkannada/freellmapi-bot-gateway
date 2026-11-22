// Bot virtual-key administration. Mounted under /api/bots behind the dashboard
// session gate. The full key is returned exactly once from create/rotate; every
// other response shows only the masked form.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  botUsageStats,
  createBot,
  deleteBot,
  getBot,
  listBots,
  rotateBotKey,
  updateBot,
} from '../services/bot-keys.js';
import { queueStats, resetQueue } from '../services/bot-queue.js';

export const botsRouter = Router();

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,99}$/;

const createSchema = z.object({
  name: z.string().trim().regex(NAME_RE, 'name must be 1-100 safe characters'),
  rpmLimit: z.number().int().min(1).max(100000).optional(),
  tpmLimit: z.number().int().min(1).max(100000000).optional(),
  dailyLimit: z.number().int().min(1).max(100000000).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  concurrency: z.number().int().min(1).max(128).optional(),
  allowedModels: z.array(z.string().min(1).max(200)).max(500).nullish(),
  routingStrategy: z.enum(['balanced', 'smartest', 'fastest', 'reliable']).nullish(),
});

const updateSchema = createSchema.partial().extend({ enabled: z.boolean().optional() });

function idOf(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid bot id' } });
    return null;
  }
  return id;
}

function badRequest(res: Response, err: unknown): void {
  res.status(400).json({ error: { message: err instanceof z.ZodError ? err.issues[0]?.message ?? 'Invalid input' : 'Invalid input' } });
}

botsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ bots: listBots() });
});

botsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { bot, key } = createBot(parsed.data);
  res.status(201).json({ bot, key });
});

botsRouter.get('/queue', (_req: Request, res: Response) => {
  res.json(queueStats());
});

botsRouter.get('/:id', (req: Request, res: Response) => {
  const id = idOf(req, res);
  if (id == null) return;
  const bot = getBot(id);
  if (!bot) return void res.status(404).json({ error: { message: 'Bot not found' } });
  res.json({ bot });
});

botsRouter.patch('/:id', (req: Request, res: Response) => {
  const id = idOf(req, res);
  if (id == null) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const bot = updateBot(id, parsed.data);
  if (!bot) return void res.status(404).json({ error: { message: 'Bot not found' } });
  res.json({ bot });
});

botsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = idOf(req, res);
  if (id == null) return;
  if (!deleteBot(id)) return void res.status(404).json({ error: { message: 'Bot not found' } });
  res.status(204).end();
});

botsRouter.post('/:id/rotate', (req: Request, res: Response) => {
  const id = idOf(req, res);
  if (id == null) return;
  const rotated = rotateBotKey(id);
  if (!rotated) return void res.status(404).json({ error: { message: 'Bot not found' } });
  res.json(rotated);
});

botsRouter.get('/:id/usage', (req: Request, res: Response) => {
  const id = idOf(req, res);
  if (id == null) return;
  const bot = getBot(id);
  if (!bot) return void res.status(404).json({ error: { message: 'Bot not found' } });
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  res.json({ bot: bot.name, days, ...botUsageStats(id, days) });
});

// Test-only hook used by the fault-simulation suite to release stuck waiters.
// Never enabled outside NODE_ENV=test.
if (process.env.NODE_ENV === 'test') {
  botsRouter.post('/_reset-queue', (_req: Request, res: Response) => {
    resetQueue();
    res.json({ ok: true });
  });
}

