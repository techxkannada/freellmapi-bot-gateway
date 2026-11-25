#!/data/data/com.termux/files/usr/bin/bash
# One-command Termux install for this fork. Safe to re-run: it updates an
# existing checkout instead of deleting it.
#
#   bash scripts/termux-install.sh [repo-url] [branch] [destination]
#
# Defaults install this fork's automation branch to ~/freellmapi-bot-gateway
# and bind the gateway to the phone's LAN address with TUNNEL=local.
set -euo pipefail

REPO="${1:-https://github.com/techxkannada/freellmapi-bot-gateway.git}"
BRANCH="${2:-feat/bot-automation-gateway}"
DEST="${3:-$HOME/freellmapi-bot-gateway}"
PORT="${PORT:-3001}"

echo "[termux] updating packages"
pkg update -y
pkg upgrade -y
# python + make are needed if better-sqlite3 has to compile. The server also
# supports node:sqlite on Termux builds that report process.platform=android.
pkg install -y nodejs-lts git python make

NODE_VERSION="$(node -p process.versions.node)"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(node -p process.versions.node.split('.')[1])"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "[termux] Node $NODE_VERSION is too old; need >=22.13 for node:sqlite" >&2
  exit 1
fi
echo "[termux] node $NODE_VERSION"

if [ -d "$DEST/.git" ]; then
  echo "[termux] updating existing checkout at $DEST"
  git -C "$DEST" fetch origin "$BRANCH"
  git -C "$DEST" checkout -B "$BRANCH" "origin/$BRANCH"
else
  echo "[termux] cloning $REPO ($BRANCH) into $DEST"
  git clone -b "$BRANCH" --single-branch "$REPO" "$DEST"
fi
cd "$DEST"

# The optional native SQLite module may fail to build on-device; the server
# falls back to node:sqlite on Termux. Approve esbuild's install script when
# npm asks, so the dashboard build works.
npm_config_yes=true npm install --no-audit --no-fund
npm run build

# Persist the local/LAN configuration. Override by editing this file later.
cat > .env <<EOF
PORT=$PORT
HOST=0.0.0.0
TUNNEL=local
TUNNEL_BIND=lan
AUTO_FAST_SWITCH=1
AUTO_SWITCH_QUOTA_PCT=80
AUTO_SWITCH_HEDGE_MS=8000
EOF

LAN_IP="$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -n1)"
[ -n "$LAN_IP" ] || LAN_IP="$(hostname -i 2>/dev/null || echo 127.0.0.1)"

if pgrep -f 'server/dist/index.js' >/dev/null 2>&1; then
  pkill -f 'server/dist/index.js' || true
  sleep 1
fi
nohup npm start > server.log 2>&1 &
echo "[termux] starting gateway on http://$LAN_IP:$PORT"
sleep 6
curl -fsS "http://127.0.0.1:$PORT/health" | head -c 600 || {
  echo "[termux] health check failed — see server.log" >&2
  tail -n 40 server.log >&2
  exit 1
}
echo
echo "[termux] API:  http://$LAN_IP:$PORT/v1"
echo "[termux] tunnel URL: http://$LAN_IP:$PORT/v1"
echo "[termux] logs: $DEST/server.log"
