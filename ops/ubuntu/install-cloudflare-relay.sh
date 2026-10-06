#!/usr/bin/env bash
set -euo pipefail

REMOTE_PORT="${REMOTE_PORT:-43000}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo: sudo $0"
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive

if ! command -v curl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl ca-certificates
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi

echo "cloudflared: $(cloudflared --version | head -n 1)"

if systemctl list-unit-files --type=service | grep -q '^cloudflared\.service'; then
  echo "cloudflared.service already exists; refusing to overwrite an existing tunnel service."
  echo "Inspect it with: sudo systemctl status cloudflared --no-pager"
  exit 3
fi

if [[ -z "${TUNNEL_TOKEN:-}" ]]; then
  read -r -s -p "Paste Cloudflare token OR full install/run command (input hidden): " TUNNEL_TOKEN
  echo
fi

if [[ -z "${TUNNEL_TOKEN}" ]]; then
  echo "Tunnel token is required."
  exit 4
fi

# Accept either the raw eyJ... tunnel token or the complete command copied
# from Cloudflare Dashboard. This avoids accidental `sudo ...` input being
# passed to cloudflared as if it were base64 token data.
RAW_INPUT="${TUNNEL_TOKEN}"
if [[ "${RAW_INPUT}" =~ (eyJ[A-Za-z0-9._=-]+) ]]; then
  TUNNEL_TOKEN="${BASH_REMATCH[1]}"
else
  echo "Could not find a Cloudflare tunnel token beginning with 'eyJ'."
  unset RAW_INPUT TUNNEL_TOKEN
  exit 4
fi
unset RAW_INPUT

cloudflared service install "${TUNNEL_TOKEN}"
unset TUNNEL_TOKEN

systemctl enable cloudflared.service >/dev/null
systemctl restart cloudflared.service
sleep 2

if ! systemctl is-active --quiet cloudflared.service; then
  systemctl status cloudflared.service --no-pager || true
  exit 5
fi

echo
echo "[OK] cloudflared system service is active."
echo "Configure the tunnel Public Hostname in Cloudflare Dashboard to:"
echo "  Service: http://127.0.0.1:${REMOTE_PORT}"
echo
echo "The relay port intentionally stays loopback-only."
echo "When Windows reverse SSH is OFF, the stable hostname remains but the origin is unavailable."
