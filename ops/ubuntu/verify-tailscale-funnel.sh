#!/usr/bin/env bash
set -uo pipefail

REMOTE_PORT="${REMOTE_PORT:-43000}"

echo "--- tailscale ---"
if ! command -v tailscale >/dev/null 2>&1; then
  echo "not installed"
  exit 2
fi
tailscale version | head -n 2

TAILSCALED_STATE="$(systemctl is-active tailscaled.service 2>/dev/null || true)"
echo "tailscaled=$TAILSCALED_STATE"
if [[ "$TAILSCALED_STATE" != "active" ]]; then
  exit 3
fi

echo "--- relay ---"
if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "http://127.0.0.1:${REMOTE_PORT}/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d == {"status":"ok","name":"codex-mcp-server"} else 1)' >/dev/null 2>&1; then
  echo "127.0.0.1:${REMOTE_PORT}=HEALTHY"
else
  echo "127.0.0.1:${REMOTE_PORT}=DOWN"
  exit 4
fi

echo "--- funnel config ---"
tailscale funnel status 2>/dev/null || {
  echo "unable to read Funnel status"
  exit 5
}

HOST="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print((json.load(sys.stdin).get("Self",{}).get("DNSName") or "").rstrip("."))' 2>/dev/null || true)"
if [[ -z "$HOST" ]]; then
  echo "public_funnel=UNKNOWN (missing Self.DNSName)"
  exit 6
fi

echo "--- true public path (DoH + forced public A) ---"
IPS="$(python3 - "$HOST" <<'PY'
import json
import sys
import urllib.parse
import urllib.request

host = sys.argv[1]
url = "https://dns.google/resolve?" + urllib.parse.urlencode({"name": host, "type": "A"})
request = urllib.request.Request(url, headers={"User-Agent": "hyperix-mcp-funnel-verify/1"})
with urllib.request.urlopen(request, timeout=8) as response:
    payload = json.load(response)

seen = []
for answer in payload.get("Answer", []):
    if answer.get("type") == 1 and isinstance(answer.get("data"), str):
        ip = answer["data"].strip()
        if ip and ip not in seen:
            seen.append(ip)

if not seen:
    raise SystemExit(2)

print("\n".join(seen))
PY
)" || {
  echo "public_funnel=UNKNOWN (public DoH lookup failed)"
  exit 7
}

while IFS= read -r IP; do
  [[ -n "$IP" ]] || continue
  echo "probe=$IP"
  if curl --fail --silent --show-error --connect-timeout 4 --max-time 8 --resolve "${HOST}:443:${IP}" "https://${HOST}/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d == {"status":"ok","name":"codex-mcp-server"} else 1)' >/dev/null 2>&1; then
    echo "public_funnel=HEALTHY"
    echo "PUBLIC_FUNNEL_VERIFY_PASS"
    exit 0
  fi
done <<<"$IPS"

echo "public_funnel=UNHEALTHY"
echo "PUBLIC_FUNNEL_VERIFY_FAIL"
exit 8