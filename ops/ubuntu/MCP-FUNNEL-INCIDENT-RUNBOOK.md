# MCP Funnel incident runbook

## Core incident signature

The confirmed failure mode is **not an MCP server failure**.

Known-good lower layers during the incident:

1. Windows MCP `http://127.0.0.1:3000/health` returned the minimal healthy JSON.
2. Admin API authentication passed.
3. Ubuntu reverse SSH relay `127.0.0.1:43000` reached the Windows MCP.
4. The protected local and reverse-relay MCP route returned HTTP 400, which is the expected transport-level response for a plain request.
5. `tailscale funnel status` still showed the expected public mappings.

Failed layer:

- Public Funnel TCP connected, but TLS closed immediately after ClientHello.
- Both public 443 and 8443 reproduced the same failure.
- A genuine public DNS lookup returned Tailscale Funnel ingress addresses, so the failure was not caused by MagicDNS or a wrong A record.
- A live `tailscaled` log watch showed no matching ingress/peerapi event while the public TLS request failed.

The public edge therefore was not delivering the request to the node even though local Funnel configuration still said "Funnel on".

## Recovery that actually worked

Re-publishing the 443 Funnel mapping did **not** recover the path.

A narrow restart of `tailscaled.service` did:

1. snapshot Tailscale/Funnel state;
2. restart only `tailscaled.service`;
3. wait for `BackendState=Running`;
4. confirm both Funnel mappings persisted;
5. verify local relay health;
6. run the full Windows verifier.

Acceptance result:

- Local MCP health PASS
- Admin API auth PASS
- Ubuntu reverse SSH relay PASS
- Public Funnel health PASS
- Protected public MCP route PASS
- `FULL_STACK_VERIFY_PASS`
- ChatGPT-side MCP tool probe PASS

## Best-supported root cause

The exact internal Tailscale bug is not proven locally. The evidence is consistent with stale/disrupted Funnel ingress registration or control-plane session state.

Tailscale has documented closely related cases where the local Serve/Funnel config remains correct while the public edge has no usable ingress target, causing TLS to close before HTTP. Restarting the Tailscale service is a known recovery in that failure class.

Do not misdiagnose this as:

- MCP code failure,
- MCP token failure,
- reverse SSH failure,
- AdGuard/router DNS failure,
- Schannel-only failure,
- a single Funnel port misconfiguration.

## Prevention/hardening

The Hyperix watchdog validates the **true public path**, not an in-tailnet MagicDNS path.

It only considers restarting Tailscale when all of these are simultaneously true:

- `tailscaled` is active;
- BackendState is `Running`;
- local MCP relay `127.0.0.1:43000/health` is healthy;
- Funnel 443 still maps to `127.0.0.1:43000`;
- public A records are obtained through HTTPS DNS (Google DoH), bypassing LAN UDP/53 interception;
- the public HTTPS health endpoint fails twice;
- prerequisites remain unchanged after the confirmation delay.

Before a restart it captures diagnostics and first tries the lower-impact `tailscale debug force-netmap-update`. If that does not restore the public path, it performs one `tailscaled` restart and verifies recovery. A cooldown prevents restart loops during a genuine Tailscale outage.

The watchdog deliberately does **not** restart Tailscale when the local MCP relay is down, when Funnel config is missing, when BackendState is not Running, or when public DoH itself is unavailable.

## Operational commands

True public-path verification on Ubuntu:

```bash
~/chatgpt-mcp-relay/verify-tailscale-funnel.sh
```

Watchdog status:

```bash
sudo cat /var/lib/hyperix-mcp-funnel-watchdog/status.json
systemctl status hyperix-mcp-funnel-watchdog.timer --no-pager
sudo journalctl -u hyperix-mcp-funnel-watchdog.service --since=-30min --no-pager
```

Full Windows acceptance:

```powershell
& "C:\path\to\ChatGPT Local\VERIFY-CHATGPT-ALL.ps1"
```

Do not reset Funnel, logout the node, delete Tailscale state, or change MCP credentials as the first response to this signature.
