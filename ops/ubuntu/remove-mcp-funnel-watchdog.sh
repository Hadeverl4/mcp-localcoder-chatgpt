#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0"
  exit 2
fi

systemctl disable --now hyperix-mcp-funnel-watchdog.timer 2>/dev/null || true
systemctl stop hyperix-mcp-funnel-watchdog.service 2>/dev/null || true

rm -f /etc/systemd/system/hyperix-mcp-funnel-watchdog.timer
rm -f /etc/systemd/system/hyperix-mcp-funnel-watchdog.service
rm -f /usr/local/libexec/hyperix-mcp-funnel-watchdog

systemctl daemon-reload
systemctl reset-failed hyperix-mcp-funnel-watchdog.service 2>/dev/null || true

echo "MCP_FUNNEL_WATCHDOG_REMOVED"
echo "State/log evidence was intentionally preserved under:"
echo "  /var/lib/hyperix-mcp-funnel-watchdog"
echo "  /var/log/hyperix-mcp-funnel-watchdog"
