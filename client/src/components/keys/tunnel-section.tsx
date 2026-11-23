import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'

interface TunnelStatus {
  mode: 'local' | 'cloudflare' | 'tailscale' | 'ngrok'
  active: boolean
  url: string | null
  localUrl: string
  binary: string | null
  pid: number | null
  reconnects: number
  lastError: string | null
  authRequired: boolean
  skipWarningHeader: string | null
  config?: { availableModes: string[] }
}

export function TunnelSection() {
  const queryClient = useQueryClient()
  const { data, isError } = useQuery<TunnelStatus>({
    queryKey: ['tunnel'],
    queryFn: () => apiFetch('/api/tunnel'),
    refetchInterval: 5000,
  })

  const control = useMutation({
    mutationFn: (action: 'start' | 'stop' | 'restart') =>
      apiFetch<TunnelStatus>(`/api/tunnel/${action}`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tunnel'] }),
  })

  const switchMode = useMutation({
    mutationFn: (mode: string) =>
      apiFetch<TunnelStatus>('/api/tunnel/mode', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tunnel'] }),
  })

  async function copy(value: string | null | undefined) {
    if (!value) return
    await copyText(value)
  }

  const snippet = data?.url
    ? `curl ${data.url.replace('/v1', '/v1/chat/completions')} \\\n  -H "Authorization: Bearer $API_KEY" \\\n${data.skipWarningHeader ? `  -H "${data.skipWarningHeader}" \\\n` : ''}  -H "Content-Type: application/json"`
    : ''

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">Public tunnel</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            One link for every bot. Set <code className="font-mono">TUNNEL</code> in .env or pass <code className="font-mono">--tunnel</code> on start.
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${data?.active ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-muted-foreground'}`}>
          {data?.active ? 'live' : 'offline'}
        </span>
      </div>

      {isError ? (
        <p className="mt-3 text-xs text-destructive">Could not read tunnel status — is the server reachable?</p>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <label className="text-muted-foreground" htmlFor="tunnel-mode">mode</label>
            <select
              id="tunnel-mode"
              className="rounded-md border bg-background px-2 py-1 font-mono"
              value={data?.mode ?? 'local'}
              disabled={switchMode.isPending}
              onChange={(e) => switchMode.mutate(e.target.value)}
            >
              {(data?.config?.availableModes ?? ['local', 'cloudflare', 'tailscale', 'ngrok']).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {data?.authRequired && <span className="text-muted-foreground">· API key required</span>}
            {switchMode.isPending && <span className="text-muted-foreground">switching…</span>}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Endpoint URL</span>
              <button className="text-xs underline-offset-2 hover:underline" onClick={() => copy(data?.url)}>Copy</button>
            </div>
            <code className="mt-1 block truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs">
              {data?.url ?? data?.localUrl ?? '—'}
            </code>
          </div>

          {data?.skipWarningHeader && (
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">curl snippet (ngrok warning bypass)</span>
                <button className="text-xs underline-offset-2 hover:underline" onClick={() => copy(snippet)}>Copy</button>
              </div>
              <pre className="mt-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11px]">{snippet}</pre>
            </div>
          )}

          {data?.lastError && <p className="text-xs text-amber-500">{data.lastError}</p>}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={control.isPending} onClick={() => control.mutate('start')}>Start</Button>
            <Button size="sm" variant="secondary" disabled={control.isPending} onClick={() => control.mutate('restart')}>Restart</Button>
            <Button size="sm" variant="ghost" disabled={control.isPending || data?.mode === 'local'} onClick={() => control.mutate('stop')}>Stop</Button>
          </div>
        </div>
      )}
    </section>
  )
}
