#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0"
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG_SRC="$SCRIPT_DIR/hyperix-mcp-funnel-watchdog.sh"
SERVICE_SRC="$SCRIPT_DIR/hyperix-mcp-funnel-watchdog.service"
TIMER_SRC="$SCRIPT_DIR/hyperix-mcp-funnel-watchdog.timer"

for path in "$WATCHDOG_SRC" "$SERVICE_SRC" "$TIMER_SRC"; do
  [[ -f "$path" ]] || { echo "Missing source file: $path"; exit 3; }
done

for cmd in tailscale curl python3 systemctl install; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing command: $cmd"; exit 4; }
done

if ! systemctl is-active --quiet tailscaled.service; then
  echo "tailscaled.service is not active; refusing installation."
  exit 5
fi

if ! curl --fail --silent --show-error --connect-timeout 2 --max-time 5   http://127.0.0.1:43000/health   | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d == {"status":"ok","name":"codex-mcp-server"} else 1)'   >/dev/null; then
  echo "Local MCP relay 127.0.0.1:43000 is not healthy; refusing installation."
  exit 6
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/var/lib/hyperix-mcp-funnel-watchdog/install-backup-$STAMP"
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

backup_if_present() {
  local src="$1"
  if [[ -e "$src" ]]; then
    cp -a -- "$src" "$BACKUP_DIR/"
  fi
}

backup_if_present /usr/local/libexec/hyperix-mcp-funnel-watchdog
backup_if_present /etc/systemd/system/hyperix-mcp-funnel-watchdog.service
backup_if_present /etc/systemd/system/hyperix-mcp-funnel-watchdog.timer

install -d -m 0755 /usr/local/libexec
install -m 0755 "$WATCHDOG_SRC" /usr/local/libexec/hyperix-mcp-funnel-watchdog
install -m 0644 "$SERVICE_SRC" /etc/systemd/system/hyperix-mcp-funnel-watchdog.service
install -m 0644 "$TIMER_SRC" /etc/systemd/system/hyperix-mcp-funnel-watchdog.timer

systemctl daemon-reload
systemctl enable --now hyperix-mcp-funnel-watchdog.timer
systemctl start hyperix-mcp-funnel-watchdog.service

echo
echo "=== watchdog status ==="
systemctl is-enabled hyperix-mcp-funnel-watchdog.timer
systemctl is-active hyperix-mcp-funnel-watchdog.timer
systemctl status hyperix-mcp-funnel-watchdog.service --no-pager -n 12 || true

echo
echo "=== last watchdog state ==="
cat /var/lib/hyperix-mcp-funnel-watchdog/status.json 2>/dev/null || true

echo
echo "MCP_FUNNEL_WATCHDOG_INSTALL_PASS"
echo "Backup: $BACKUP_DIR"
