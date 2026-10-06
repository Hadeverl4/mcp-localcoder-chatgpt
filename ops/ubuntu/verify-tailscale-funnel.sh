#!/usr/bin/env bash
set -u
REMOTE_PORT="${REMOTE_PORT:-43000}"

echo "--- tailscale ---"
if command -v tailscale >/dev/null 2>&1; then
  tailscale version | head -n 2
else
  echo "not installed"
fi

echo "tailscaled=$(systemctl is-active tailscaled.service 2>/dev/null || true)"
echo "--- relay ---"
if ss -lnt | grep -q "127.0.0.1:${REMOTE_PORT} "; then
  echo "127.0.0.1:${REMOTE_PORT}=LISTENING"
else
  echo "127.0.0.1:${REMOTE_PORT}=DOWN"
fi

echo "--- funnel ---"
tailscale funnel status 2>/dev/null || true
