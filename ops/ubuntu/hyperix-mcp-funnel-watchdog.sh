#!/usr/bin/env bash
set -euo pipefail

REMOTE_PORT="${REMOTE_PORT:-43000}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-3600}"
RECHECK_DELAY_SECONDS="${RECHECK_DELAY_SECONDS:-10}"
STATE_DIR="${STATE_DIR:-/var/lib/hyperix-mcp-funnel-watchdog}"
LOG_DIR="${LOG_DIR:-/var/log/hyperix-mcp-funnel-watchdog}"

mkdir -p "$STATE_DIR" "$LOG_DIR"
chmod 0700 "$STATE_DIR" "$LOG_DIR" 2>/dev/null || true

STATUS_FILE="$STATE_DIR/status.json"
LAST_RESTART_FILE="$STATE_DIR/last-restart.epoch"

log() {
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$*"
}

write_status() {
  local state="$1"
  local action="$2"
  local detail="$3"
  python3 - "$STATUS_FILE" "$state" "$action" "$detail" <<'PY'
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

path, state, action, detail = sys.argv[1:5]
payload = {
    "timestamp": datetime.now(timezone.utc).astimezone().isoformat(),
    "state": state,
    "action": action,
    "detail": detail,
}
directory = os.path.dirname(path)
fd, tmp = tempfile.mkstemp(prefix=".status-", dir=directory, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
finally:
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
PY
}

get_status_json() {
  tailscale status --json 2>/dev/null
}

get_backend_state() {
  get_status_json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))'
}

get_dns_name() {
  get_status_json | python3 -c 'import json,sys; print((json.load(sys.stdin).get("Self",{}).get("DNSName") or "").rstrip("."))'
}

local_relay_healthy() {
  curl --fail --silent --show-error     --connect-timeout 2 --max-time 5     "http://127.0.0.1:${REMOTE_PORT}/health"     | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d == {"status":"ok","name":"codex-mcp-server"} else 1)'     >/dev/null 2>&1
}

funnel_mapping_healthy() {
  local host="$1"
  local funnel_json
  funnel_json="$(tailscale funnel status --json 2>/dev/null)" || return 1
  FUNNEL_JSON="$funnel_json" python3 - "$host" "$REMOTE_PORT" <<'PY'
import json
import os
import sys

host, port = sys.argv[1], sys.argv[2]
data = json.loads(os.environ["FUNNEL_JSON"])
key = f"{host}:443"
expected = f"http://127.0.0.1:{port}"

tcp = data.get("TCP", {}).get("443", {})
web = data.get("Web", {}).get(key, {})
handler = web.get("Handlers", {}).get("/", {})
allow = data.get("AllowFunnel", {}).get(key)

ok = bool(tcp.get("HTTPS")) and handler.get("Proxy") == expected and allow is True
raise SystemExit(0 if ok else 1)
PY
}

public_ipv4s() {
  local host="$1"
  python3 - "$host" <<'PY'
import json
import sys
import urllib.parse
import urllib.request

host = sys.argv[1]
url = "https://dns.google/resolve?" + urllib.parse.urlencode({"name": host, "type": "A"})
request = urllib.request.Request(url, headers={"User-Agent": "hyperix-mcp-funnel-watchdog/1"})
with urllib.request.urlopen(request, timeout=8) as response:
    payload = json.load(response)

ips = []
for answer in payload.get("Answer", []):
    if answer.get("type") == 1 and isinstance(answer.get("data"), str):
        ip = answer["data"].strip()
        if ip and ip not in ips:
            ips.append(ip)

if not ips:
    raise SystemExit(2)

for ip in ips:
    print(ip)
PY
}

probe_public_ip() {
  local host="$1"
  local ip="$2"
  curl --fail --silent --show-error     --connect-timeout 4 --max-time 8     --resolve "${host}:443:${ip}"     "https://${host}/health"     | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d == {"status":"ok","name":"codex-mcp-server"} else 1)'     >/dev/null 2>&1
}

public_funnel_healthy() {
  local host="$1"
  local ips
  if ! ips="$(public_ipv4s "$host" 2>/dev/null)"; then
    return 2
  fi

  local ip
  while IFS= read -r ip; do
    [[ -n "$ip" ]] || continue
    if probe_public_ip "$host" "$ip"; then
      return 0
    fi
  done <<<"$ips"

  return 1
}

cooldown_active() {
  [[ -f "$LAST_RESTART_FILE" ]] || return 1
  local last now
  last="$(cat "$LAST_RESTART_FILE" 2>/dev/null || true)"
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  (( now - last < COOLDOWN_SECONDS ))
}

capture_diagnostics() {
  local stamp diag
  stamp="$(date +%Y%m%d-%H%M%S)"
  diag="$LOG_DIR/incident-$stamp.log"
  {
    echo "timestamp=$(date --iso-8601=seconds)"
    echo "--- tailscale version ---"
    tailscale version || true
    echo "--- tailscale status ---"
    tailscale status || true
    echo "--- funnel status ---"
    tailscale funnel status || true
    echo "--- netcheck ---"
    tailscale netcheck || true
    echo "--- recent tailscaled log ---"
    journalctl -u tailscaled --since="-10 minutes" --no-pager       | grep -Ei 'control:|peerapi|ingress|funnel|serve|derp|relay|error|warn'       | tail -n 120 || true
  } >"$diag" 2>&1
  chmod 0600 "$diag" 2>/dev/null || true
  log "diagnostic=$diag"
}

wait_for_backend() {
  local i
  for i in $(seq 1 30); do
    if systemctl is-active --quiet tailscaled.service; then
      if [[ "$(get_backend_state 2>/dev/null || true)" == "Running" ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

main() {
  if ! command -v tailscale >/dev/null 2>&1 ||
     ! command -v curl >/dev/null 2>&1 ||
     ! command -v python3 >/dev/null 2>&1; then
    log "PRECHECK_FAIL required command missing"
    write_status "precheck_failed" "none" "tailscale/curl/python3 required"
    return 0
  fi

  if ! systemctl is-active --quiet tailscaled.service; then
    log "CORE_UNHEALTHY tailscaled is not active; watchdog will not mutate"
    write_status "core_unhealthy" "none" "tailscaled inactive"
    return 0
  fi

  local backend host
  backend="$(get_backend_state 2>/dev/null || true)"
  if [[ "$backend" != "Running" ]]; then
    log "CORE_UNHEALTHY BackendState=$backend; watchdog will not mutate"
    write_status "core_unhealthy" "none" "BackendState=$backend"
    return 0
  fi

  host="$(get_dns_name 2>/dev/null || true)"
  if [[ -z "$host" ]]; then
    log "PRECHECK_FAIL unable to determine Tailscale DNS name"
    write_status "precheck_failed" "none" "missing Self.DNSName"
    return 0
  fi

  if ! local_relay_healthy; then
    log "CORE_UNHEALTHY local relay 127.0.0.1:$REMOTE_PORT is not healthy; no Tailscale restart"
    write_status "core_unhealthy" "none" "local MCP relay unhealthy"
    return 0
  fi

  if ! funnel_mapping_healthy "$host"; then
    log "CONFIG_MISMATCH Funnel 443 mapping is not the expected localhost relay; no mutation"
    write_status "config_mismatch" "none" "expected 443 -> 127.0.0.1:$REMOTE_PORT"
    return 0
  fi

  if public_funnel_healthy "$host"; then
    log "HEALTHY public Funnel is reachable through genuine public DNS"
    write_status "healthy" "none" "public Funnel healthy"
    return 0
  else
    local probe_rc=$?
    if [[ "$probe_rc" -eq 2 ]]; then
      log "AMBIGUOUS public DoH lookup failed; no restart"
      write_status "ambiguous" "none" "public DNS-over-HTTPS lookup failed"
      return 0
    fi
  fi

  log "SUSPECT public Funnel failed while local relay, tailscaled, and mapping are healthy; rechecking in ${RECHECK_DELAY_SECONDS}s"
  sleep "$RECHECK_DELAY_SECONDS"

  if public_funnel_healthy "$host"; then
    log "RECOVERED_TRANSIENT second public probe succeeded; no restart"
    write_status "healthy" "none" "transient public failure recovered"
    return 0
  else
    local probe_rc=$?
    if [[ "$probe_rc" -eq 2 ]]; then
      log "AMBIGUOUS second DoH lookup failed; no restart"
      write_status "ambiguous" "none" "second public DNS-over-HTTPS lookup failed"
      return 0
    fi
  fi

  if ! local_relay_healthy ||
     [[ "$(get_backend_state 2>/dev/null || true)" != "Running" ]] ||
     ! funnel_mapping_healthy "$host"; then
    log "STATE_CHANGED prerequisites changed during confirmation window; no restart"
    write_status "state_changed" "none" "recovery prerequisites no longer exact"
    return 0
  fi

  capture_diagnostics

  if cooldown_active; then
    log "DEGRADED restart cooldown active; preserving current state"
    write_status "degraded" "cooldown" "exact stale-ingress signature persists during cooldown"
    return 0
  fi

  log "REPAIR trying non-disruptive force-netmap-update first"
  tailscale debug force-netmap-update >/dev/null 2>&1 || true
  sleep 8

  if public_funnel_healthy "$host"; then
    log "RECOVERED force-netmap-update restored public Funnel"
    write_status "recovered" "force-netmap-update" "public Funnel recovered without daemon restart"
    return 0
  fi

  date +%s >"$LAST_RESTART_FILE"
  chmod 0600 "$LAST_RESTART_FILE" 2>/dev/null || true

  log "REPAIR restarting tailscaled.service after exact stale-ingress signature"
  systemctl restart tailscaled.service

  if ! wait_for_backend; then
    log "DEGRADED tailscaled did not return to BackendState=Running"
    write_status "degraded" "tailscaled_restart" "tailscaled did not return to Running"
    return 0
  fi

  if ! local_relay_healthy; then
    log "DEGRADED local MCP relay is unhealthy after tailscaled restart"
    write_status "degraded" "tailscaled_restart" "local relay unhealthy after restart"
    return 0
  fi

  if ! funnel_mapping_healthy "$host"; then
    log "DEGRADED Funnel mapping did not persist after tailscaled restart"
    write_status "degraded" "tailscaled_restart" "Funnel mapping missing after restart"
    return 0
  fi

  local i
  for i in $(seq 1 6); do
    if public_funnel_healthy "$host"; then
      log "RECOVERED tailscaled restart restored public Funnel on attempt $i"
      write_status "recovered" "tailscaled_restart" "public Funnel recovered"
      return 0
    fi
    sleep 5
  done

  log "DEGRADED public Funnel still unavailable after one guarded restart; cooldown prevents restart loop"
  write_status "degraded" "tailscaled_restart" "public Funnel still unavailable after guarded restart"
  return 0
}

main "$@"
