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
