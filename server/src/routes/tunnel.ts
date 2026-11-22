// Tunnel control plane. Dashboard-session gated like every /api route: the
// unified inference key must never be able to start or stop a public tunnel.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  findBinary,
  getTunnelConfig,
  getTunnelStatus,
  restartTunnel,
  startTunnel,
  stopTunnel,
  waitForTunnelUrl,
} from '../services/tunnel.js';

export const tunnelRouter = Router();

tunnelRouter.get('/', (_req: Request, res: Response) => {
  res.json({ ...getTunnelStatus(), config: publicConfig() });
});

tunnelRouter.post('/start', async (_req: Request, res: Response) => {
  const status = await startTunnel();
  const url = await waitForTunnelUrl(status.mode === 'local' ? 1000 : 15_000);
  res.json({ ...getTunnelStatus(), url: url ?? status.url });
});

tunnelRouter.post('/stop', async (_req: Request, res: Response) => {
  res.json(await stopTunnel());
});

tunnelRouter.post('/restart', async (_req: Request, res: Response) => {
  const status = await restartTunnel();
  const url = await waitForTunnelUrl(status.mode === 'local' ? 1000 : 15_000);
  res.json({ ...getTunnelStatus(), url: url ?? status.url });
});

// Which binary would be used, without starting anything — lets the dashboard
// tell an operator what to install before they flip the mode.
tunnelRouter.get('/binaries', (_req: Request, res: Response) => {
  res.json({
    cloudflare: findBinary('cloudflare'),
    tailscale: findBinary('tailscale'),
    ngrok: findBinary('ngrok'),
  });
});

function publicConfig() {
  const cfg = getTunnelConfig();
  return {
    mode: cfg.mode,
    port: cfg.port,
    localUrl: cfg.localUrl,
    authRequired: cfg.mode !== 'local',
    // Booleans only — no token, hostname or authtoken is ever sent to the UI.
    cloudflare: { named: !cfg.cloudflare.quick, configured: Boolean(cfg.cloudflare.token) },
    tailscale: { mode: cfg.tailscale.funnel ? 'funnel' : 'serve' },
    ngrok: { reservedDomain: Boolean(cfg.ngrok.domain), authtoken: Boolean(cfg.ngrok.authtoken) },
    availableModes: ['local', 'cloudflare', 'tailscale', 'ngrok'],
  };
}
