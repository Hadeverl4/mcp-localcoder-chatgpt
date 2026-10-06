#!/usr/bin/env bash
set -u
REMOTE_PORT="${REMOTE_PORT:-43000}"

echo "--- cloudflared ---"
if command -v cloudflared >/dev/null 2>&1; then
  cloudflared --version
else
  echo "not installed"
fi

if systemctl is-active --quiet cloudflared.service 2>/dev/null; then
  echo "service=active"
else
  echo "service=inactive"
fi

echo "--- relay ---"
if ss -lnt | grep -q "127.0.0.1:${REMOTE_PORT} "; then
  echo "127.0.0.1:${REMOTE_PORT}=LISTENING"
  if curl -fsS --connect-timeout 2 --max-time 4 "http://127.0.0.1:${REMOTE_PORT}/health" >/dev/null; then
    echo "relay_health=OK"
  else
    echo "relay_health=FAILED"
  fi
else
  echo "127.0.0.1:${REMOTE_PORT}=DOWN"
fi
