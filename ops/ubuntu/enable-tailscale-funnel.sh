#!/usr/bin/env bash
set -euo pipefail

REMOTE_PORT="${REMOTE_PORT:-43000}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0"
  exit 2
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale is not installed."
  exit 3
fi

if ! tailscale status >/dev/null 2>&1; then
  echo "This Ubuntu server is not authenticated to a tailnet."
  echo "Run: sudo tailscale up"
  exit 4
fi

echo "Enabling persistent public Funnel -> http://127.0.0.1:${REMOTE_PORT}"
tailscale funnel --bg "${REMOTE_PORT}"

echo
echo "[OK] Funnel configured."
tailscale funnel status
