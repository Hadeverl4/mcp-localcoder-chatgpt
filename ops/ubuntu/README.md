# Ubuntu 24/7 Cloudflare relay

## Zero-cost stable hostname alternative: Tailscale Funnel

If you do not own a domain, use Tailscale Funnel instead of a Cloudflare Published Application hostname. It provides a stable public HTTPS hostname under `*.ts.net` without buying a domain.

Prepared scripts:

```bash
sudo ~/chatgpt-mcp-relay/install-tailscale-funnel.sh
sudo tailscale up
sudo ~/chatgpt-mcp-relay/enable-tailscale-funnel.sh
~/chatgpt-mcp-relay/verify-tailscale-funnel.sh
```

The Funnel target remains `http://127.0.0.1:43000`, so the Windows reverse SSH and Owner Guard design does not change.

`verify-tailscale-funnel.sh` now verifies the **real public Funnel path** by resolving the node through HTTPS DNS and forcing curl to the public A record. This avoids the false-positive case where MagicDNS resolves the same hostname directly to the node's `100.x` tailnet address.

### Guarded Funnel watchdog

For the known failure class where local MCP + reverse SSH + Funnel config are healthy but the public TLS edge stops forwarding to the node, install the bounded watchdog:

```bash
sudo ~/chatgpt-mcp-relay/install-mcp-funnel-watchdog.sh
```

The watchdog runs every 5 minutes and only considers a `tailscaled` restart after all lower MCP layers are healthy, the expected 443 mapping is intact, genuine public DNS succeeds, and the public health endpoint fails twice. It captures diagnostics, first tries a lower-impact netmap refresh, performs at most one guarded daemon restart, and enforces a one-hour restart cooldown.

Status:

```bash
sudo cat /var/lib/hyperix-mcp-funnel-watchdog/status.json
systemctl status hyperix-mcp-funnel-watchdog.timer --no-pager
sudo journalctl -u hyperix-mcp-funnel-watchdog.service --since=-30min --no-pager
```

Rollback:

```bash
sudo ~/chatgpt-mcp-relay/remove-mcp-funnel-watchdog.sh
```

See `MCP-FUNNEL-INCIDENT-RUNBOOK.md` for the accepted incident signature and recovery logic.

Architecture:

~~~text
Cloudflare Named Tunnel (systemd on Ubuntu)
  -> http://127.0.0.1:43000
  -> reverse SSH from Windows
  -> Windows MCP http://127.0.0.1:3000
~~~

Security properties:
- Ubuntu relay port is loopback-only.
- Windows MCP remains loopback-only.
- Admin UI port 3011 is never forwarded.
- Reverse SSH is manual; it does not auto-start with Windows.
- Owner Guard remains an independent local authorization layer.
- The Cloudflare tunnel hostname can remain stable while Windows is offline; requests fail because the origin is unavailable.

## Cloudflare Dashboard

Create a remotely-managed Named Tunnel and add a Public Hostname. Point its service to:

~~~text
http://127.0.0.1:43000
~~~

Copy the tunnel token from Networking > Tunnels > <tunnel> > Add a replica.
Do not paste the token into source code or chat.

A normal public hostname route requires a domain/zone in the Cloudflare account.

## Ubuntu

The installer prompts for the tunnel token without echoing it:

~~~bash
sudo ~/chatgpt-mcp-relay/install-cloudflare-relay.sh
~~~

Verify:

~~~bash
~/chatgpt-mcp-relay/verify-relay.sh
~~~

## Windows

Start the reverse link only while you want the Windows MCP reachable through Ubuntu:

~~~powershell
.\UBUNTU-LINK-ON.ps1
.\UBUNTU-LINK-STATUS.ps1
.\UBUNTU-LINK-OFF.ps1
~~~

Defaults:
- SSH host alias: `mcp-relay` (override with `-HostAlias <your-ssh-alias>` if needed)
- Ubuntu loopback relay: 127.0.0.1:43000
- Windows MCP: 127.0.0.1:3000
