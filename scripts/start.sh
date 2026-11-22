#!/usr/bin/env bash
# Start the gateway with an optional tunnel mode.
#   ./scripts/start.sh                 # TUNNEL from .env (default: local)
#   ./scripts/start.sh --tunnel ngrok  # CLI flag wins over .env
set -euo pipefail
cd "$(dirname "$0")/.."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel)
      [[ $# -ge 2 ]] || { echo "--tunnel needs one of: local cloudflare tailscale ngrok" >&2; exit 2; }
      export TUNNEL="$2"; shift 2 ;;
    --tunnel=*)
      export TUNNEL="${1#--tunnel=}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "${TUNNEL:-local}" in
  local|cloudflare|tailscale|ngrok) ;;
  *) echo "invalid TUNNEL=${TUNNEL}: expected local|cloudflare|tailscale|ngrok" >&2; exit 2 ;;
esac

if [[ ! -f server/dist/index.js ]]; then
  echo "server not built — running npm run build first" >&2
  npm run build
fi

echo "starting FreeLLMAPI with TUNNEL=${TUNNEL:-local}"
exec npm start
