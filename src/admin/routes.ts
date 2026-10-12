import fs from "fs/promises";
import path from "path";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Router, type Request, type Response } from "express";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import {
  defaultUpstreamConfig,
  discoverMcpConfigs,
  findMcpConfigForSource,
  importMcpConfigFromFile,
  type McpImportSource,
  type UpstreamServerConfig,
} from "../lib/mcp-upstream-config.js";
import { getDefaultCwd, getFullDiskAccess } from "../lib/path-security.js";
import { getCheckpointConfig } from "../lib/checkpoint.js";
import { getLocalPluginsConfig, saveLocalPluginsConfig } from "../lib/plugin-config.js";
import { getCodexHooks, saveCodexHooks } from "../lib/codex-hooks.js";
import {
  getRecentActivity,
  loadAuditHistory,
  subscribeActivity,
  type ActivityEntry,
} from "../lib/activity-log.js";
import { getOwnerGuardStatus, setOwnerGuardMode, type OwnerMode } from "../lib/owner-guard.js";

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

function serializeDotEnv(values: Record<string, string>, original: string): string {
  const lines = original.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      result.push(line);
      continue;
    }
    const key = trimmed.split("=")[0].trim();
    if (key in values) {
      result.push(`${key}=${values[key]}`);
      seen.add(key);
    } else {
      result.push(line);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) result.push(`${key}=${value}`);
  }

  return result.join("\n");
}

export function createAdminRouter(manager: McpUpstreamManager, options: {
  mcpPort: number;
  pid: number;
  sessionCount: () => number;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
}): Router {
  const router = Router();
  const envPath = path.resolve(process.cwd(), ".env");
  let mcpLiveLastOkAt: string | null = null;
  let mcpLiveLastFailureAt: string | null = null;
  let publicDnsCache: { host: string; ips: string[]; expiresAt: number } | null = null;

  async function probeMcpHealth(url: string, timeoutMs = 4000) {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
      const body = await response.json().catch(() => null) as { status?: string; name?: string } | null;
      const ok =
        response.ok &&
        body?.status === "ok" &&
        body?.name === "codex-mcp-server";
      return {
        ok,
        http_status: response.status,
        latency_ms: Math.max(0, Math.round(performance.now() - started)),
        error: ok ? null : "Unexpected MCP health response",
      };
    } catch (err) {
      return {
        ok: false,
        http_status: 0,
        latency_ms: Math.max(0, Math.round(performance.now() - started)),
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolvePublicIpv4(host: string): Promise<string[]> {
    if (publicDnsCache?.host === host && publicDnsCache.expiresAt > Date.now()) {
      return publicDnsCache.ips;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const dohUrl = new URL("https://dns.google/resolve");
      dohUrl.searchParams.set("name", host);
      dohUrl.searchParams.set("type", "A");
      const response = await fetch(dohUrl, {
        headers: { accept: "application/dns-json" },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Public DoH returned HTTP ${response.status}`);
      const body = await response.json() as {
        Answer?: Array<{ type?: number; data?: string; TTL?: number }>;
      };
      const answers = (body.Answer || []).filter(
        (answer) => answer.type === 1 && typeof answer.data === "string" && isIP(answer.data) === 4
      );
      const ips = [...new Set(answers.map((answer) => answer.data!))];
      if (!ips.length) throw new Error("Public DoH returned no IPv4 Funnel edge");
      const ttl = Math.max(30, Math.min(300, ...answers.map((answer) => Number(answer.TTL) || 60)));
      publicDnsCache = { host, ips, expiresAt: Date.now() + ttl * 1000 };
      return ips;
    } finally {
      clearTimeout(timeout);
    }
  }

  function probeHttpsHealthAtIp(target: URL, ip: string, timeoutMs = 5000): Promise<{
    ok: boolean;
    http_status: number;
    latency_ms: number;
    error: string | null;
    ip: string;
  }> {
    return new Promise((resolve) => {
      const started = performance.now();
      let settled = false;
      const finish = (value: {
        ok: boolean;
        http_status: number;
        latency_ms: number;
        error: string | null;
        ip: string;
      }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const req = httpsRequest({
        protocol: "https:",
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        servername: target.hostname,
        headers: {
          accept: "application/json",
          host: target.host,
          "user-agent": "codex-mcp-admin-health/1",
        },
        lookup: ((_: string, options, callback) => {
          if (options.all) {
            callback(null, [{ address: ip, family: 4 }]);
          } else {
            callback(null, ip, 4);
          }
        }) satisfies LookupFunction,
      }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (text.length < 16384) text += chunk;
        });
        response.on("end", () => {
          let body: { status?: string; name?: string } | null = null;
          try {
            body = JSON.parse(text);
          } catch {}
          const ok =
            response.statusCode === 200 &&
            body?.status === "ok" &&
            body?.name === "codex-mcp-server";
          finish({
            ok,
            http_status: response.statusCode || 0,
            latency_ms: Math.max(0, Math.round(performance.now() - started)),
            error: ok ? null : "Unexpected public MCP health response",
            ip,
          });
        });
      });

      req.setTimeout(timeoutMs, () => req.destroy(new Error("Public MCP health timeout")));
      req.on("error", (err) => {
        finish({
          ok: false,
          http_status: 0,
          latency_ms: Math.max(0, Math.round(performance.now() - started)),
          error: err.message,
          ip,
        });
      });
      req.end();
    });
  }

  async function probePublicMcpHealth(publicBase: string) {
    const target = new URL(`${publicBase}/health`);
    const isTailscaleFunnel =
      (process.env.PUBLIC_TUNNEL_MODE || "").trim().toLowerCase() === "tailscale" ||
      target.hostname.endsWith(".ts.net");

    if (!isTailscaleFunnel || target.protocol !== "https:") {
      return {
        ...(await probeMcpHealth(target.toString(), 5000)),
        probe_mode: "direct",
        edge_ok: null,
        edge_total: null,
      };
    }

    try {
      const ips = await resolvePublicIpv4(target.hostname);
      const probes = await Promise.all(ips.slice(0, 4).map((ip) => probeHttpsHealthAtIp(target, ip)));
      const edgeOk = probes.filter((probe) => probe.ok).length;
      const allOk = probes.length > 0 && edgeOk === probes.length;
      return {
        ok: allOk,
        http_status: allOk ? 200 : probes.find((probe) => !probe.ok)?.http_status || 0,
        latency_ms: probes.length ? Math.max(...probes.map((probe) => probe.latency_ms)) : 0,
        error: allOk
          ? null
          : edgeOk > 0
            ? `Only ${edgeOk}/${probes.length} public Funnel edges are healthy`
            : probes[0]?.error || "Public Funnel edge probe failed",
        probe_mode: "doh_forced_public",
        edge_ok: edgeOk,
        edge_total: probes.length,
      };
    } catch (err) {
      return {
        ok: false,
        http_status: 0,
        latency_ms: 0,
        error: err instanceof Error ? err.message : String(err),
        probe_mode: "doh_forced_public",
        edge_ok: 0,
        edge_total: 0,
      };
    }
  }

  router.get("/health", async (_req: Request, res: Response) => {
    const upstream = await manager.listStatuses();
    res.json({
      status: "ok",
      name: "codex-mcp-admin",
      pid: options.pid,
      mcp_port: options.mcpPort,
      active_sessions: options.sessionCount(),
      default_cwd: getDefaultCwd(),
      full_disk_access: getFullDiskAccess(),
      upstream,
      checkpoint: getCheckpointConfig(),
      instructions: options.instructionSummary?.() ?? null,
      owner_guard: getOwnerGuardStatus(),
    });
  });

  router.get("/api/mcp-health", async (_req: Request, res: Response) => {
    const checkedAt = new Date().toISOString();
    const localUrl = `http://127.0.0.1:${options.mcpPort}/health`;
    const publicBase = (process.env.PUBLIC_TUNNEL_BASE_URL || "").trim().replace(/\/+$/, "");
    let publicHost: string | null = null;
    if (publicBase) {
      try {
        publicHost = new URL(publicBase).host;
      } catch {}
    }

    const [local, publicProbe] = await Promise.all([
      probeMcpHealth(localUrl, 2500),
      publicBase
        ? probePublicMcpHealth(publicBase)
        : Promise.resolve({
            ok: false,
            http_status: 0,
            latency_ms: 0,
            error: "PUBLIC_TUNNEL_BASE_URL is not configured",
            probe_mode: "unconfigured",
            edge_ok: null,
            edge_total: null,
          }),
    ]);

    const publicConfigured = Boolean(publicBase);
    const overall =
      !local.ok
        ? "down"
        : !publicConfigured
          ? "local_only"
          : publicProbe.ok
            ? "healthy"
            : "degraded";

    if (overall === "healthy" || overall === "local_only") {
      mcpLiveLastOkAt = checkedAt;
    } else {
      mcpLiveLastFailureAt = checkedAt;
    }

    res.json({
      ok: overall === "healthy" || overall === "local_only",
      status: overall,
      checked_at: checkedAt,
      last_ok_at: mcpLiveLastOkAt,
      last_failure_at: mcpLiveLastFailureAt,
      active_sessions: options.sessionCount(),
      local,
      public: {
        configured: publicConfigured,
        host: publicHost,
        ...publicProbe,
      },
    });
  });

  router.get("/api/owner-guard", (_req, res) => {
    res.json({ ok: true, status: getOwnerGuardStatus() });
  });

  router.put("/api/owner-guard", (req, res) => {
    try {
      const mode = String(req.body?.mode || "") as OwnerMode;
      if (!["locked", "readonly", "armed"].includes(mode)) {
        res.status(400).json({ ok: false, error: "mode must be locked, readonly, or armed" });
        return;
      }
      const minutes = Number(req.body?.minutes ?? 60);
      const idleMinutes = Number(req.body?.idle_minutes ?? 10);
      setOwnerGuardMode(mode, { minutes, idle_minutes: idleMinutes });
      res.json({ ok: true, status: getOwnerGuardStatus() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/instructions/preview", (_req, res) => {
    const text = options.instructionsPreview?.() ?? "";
    const summary = options.instructionSummary?.() ?? {};
    res.json({
      ok: true,
      summary,
      preview: text.slice(0, 12000),
      truncated: text.length > 12000,
      total_chars: text.length,
    });
  });

  router.get("/api/config/env", async (_req, res) => {
    try {
      const text = await fs.readFile(envPath, "utf-8");
      res.json({ ok: true, path: envPath, values: parseDotEnv(text) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.json({ ok: true, path: envPath, values: {} });
        return;
      }
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.put("/api/config/env", async (req, res) => {
    try {
      const values = req.body?.values as Record<string, string>;
      if (!values || typeof values !== "object") {
        res.status(400).json({ ok: false, error: "values object required" });
        return;
      }
      let original = "";
      try {
        original = await fs.readFile(envPath, "utf-8");
      } catch {}
      const next = serializeDotEnv(values, original || "");
      await fs.writeFile(envPath, next, "utf-8");
      for (const [k, v] of Object.entries(values)) {
        process.env[k] = v;
      }
      res.json({ ok: true, path: envPath });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/api/upstream", async (_req, res) => {
    res.json({ ok: true, config: manager.getConfig(), path: manager.getConfigPath() });
  });

  router.get("/api/plugins", (_req, res) => {
    res.json({ ok: true, config: getLocalPluginsConfig(), available: { computer_use: process.platform === "win32" } });
  });

  router.put("/api/plugins", (req, res) => {
    const computerUseEnabled = req.body?.config?.computer_use?.enabled === true;
    const next = { computer_use: { enabled: computerUseEnabled } };
    saveLocalPluginsConfig(next);
    res.json({ ok: true, config: next, restart_required: "Open a new ChatGPT MCP session after changing plugin state." });
  });

  router.get("/api/codex-hooks", async (_req, res) => {
    try {
      res.json({ ok: true, hooks: await getCodexHooks() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/codex-hooks", async (req, res) => {
    try {
      res.json({ ok: true, hooks: await saveCodexHooks(req.body?.enabled) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/local-tools", async (_req, res) => {
    try {
      const { LOCAL_TOOL_CATALOG } = await import("../lib/tool-profile.js");
      const configPath = path.resolve(process.cwd(), "profiles", "tool-overrides.json");
      let overrides: { enabled?: string[]; disabled?: string[] } = {};
      try {
        overrides = JSON.parse(await fs.readFile(configPath, "utf-8"));
      } catch {}
      res.json({ ok: true, tools: LOCAL_TOOL_CATALOG, overrides });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/local-tools", async (req, res) => {
    try {
      const { LOCAL_TOOL_CATALOG } = await import("../lib/tool-profile.js");
      const known = new Set(LOCAL_TOOL_CATALOG);
      const names = (value: unknown) => Array.isArray(value)
        ? [...new Set(value.filter((name): name is string => typeof name === "string" && known.has(name)))]
        : [];
      const enabled = names(req.body?.overrides?.enabled);
      const disabled = names(req.body?.overrides?.disabled).filter((name) => !enabled.includes(name));
      const configPath = path.resolve(process.cwd(), "profiles", "tool-overrides.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ enabled, disabled }, null, 2) + "\n", "utf-8");
      res.json({ ok: true, overrides: { enabled, disabled }, restart_required: "Open a new ChatGPT MCP session after changing local tool visibility." });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/upstream", async (req, res) => {
    try {
      const config = req.body?.config ?? defaultUpstreamConfig();
      const saved = await manager.updateConfig(config);
      res.json({ ok: true, config: saved });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream", async (req, res) => {
    try {
      const server = req.body?.server as UpstreamServerConfig;
      if (!server?.id) {
        res.status(400).json({ ok: false, error: "server.id required" });
        return;
      }
      await manager.upsertServer(server);
      res.json({ ok: true, config: manager.getConfig() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/upstream/:id", async (req, res) => {
    const removed = await manager.removeServer(req.params.id);
    if (!removed) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    res.json({ ok: true, config: manager.getConfig() });
  });

  router.post("/api/upstream/:id/test", async (req, res) => {
    try {
      const status = await manager.checkHealth(req.params.id);
      res.json({ ok: status.health === "connected", status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/upstream/:id/oauth/status", async (req, res) => {
    try {
      res.json({ ok: true, status: await manager.oauthStatus(req.params.id) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream/:id/oauth/start", async (req, res) => {
    try {
      const status = await manager.startOAuth(req.params.id, req.body?.reset !== false);
      res.json({ ok: true, status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream/:id/oauth/disconnect", async (req, res) => {
    try {
      await manager.disconnectOAuth(req.params.id);
      res.json({ ok: true, status: await manager.oauthStatus(req.params.id) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/upstream/:id/tools", async (req, res) => {
    try {
      const tools = await manager.listTools(req.params.id);
      const config = manager.getServerConfig(req.params.id);
      res.json({
        ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        proxied_tools: config ? manager.getProxiedToolNames(config, tools) : [],
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/import/sources", async (_req, res) => {
    try {
      const sources = await discoverMcpConfigs();
      res.json({ ok: true, sources });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function handleImport(
    source: McpImportSource,
    body: { path?: string; merge?: boolean; enable?: boolean }
  ) {
    const configPath = body.path || (await findMcpConfigForSource(source));
    if (!configPath) throw new Error(`${source} MCP config not found on this machine`);
    return importMcpConfigFromFile(configPath, source, {
      merge: body.merge !== false,
      enableImported: Boolean(body.enable),
    });
  }

  router.post("/api/import/:source", async (req, res) => {
    try {
      const source = req.params.source as McpImportSource;
      if (!["cursor", "claude", "opencode", "file"].includes(source)) {
        res.status(400).json({ ok: false, error: "Unknown import source" });
        return;
      }
      const filePath = req.body?.path as string | undefined;
      if (source === "file" && !filePath) {
        res.status(400).json({ ok: false, error: "path required for file import" });
        return;
      }
      const detectSource: McpImportSource =
        source === "file" ? (req.body?.detect_as as McpImportSource) || "cursor" : source;
      const result = await importMcpConfigFromFile(filePath || (await findMcpConfigForSource(source))!, detectSource, {
        merge: req.body?.merge !== false,
        enableImported: Boolean(req.body?.enable),
      });
      await manager.reloadConfig();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/import/cursor", async (req, res) => {
    try {
      const result = await handleImport("cursor", req.body ?? {});
      await manager.reloadConfig();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  function filterActivity(
    entries: ActivityEntry[],
    opts: { kind?: string; status?: string; tool?: string; q?: string }
  ): ActivityEntry[] {
    let out = entries;
    if (opts.kind && opts.kind !== "all") {
      out = out.filter((e) => e.kind === opts.kind);
    }
    if (opts.status === "error") {
      out = out.filter((e) => e.status === "error" || e.status === "blocked");
    }
    if (opts.tool) {
      const needle = opts.tool.toLowerCase();
      out = out.filter((e) => e.tool?.toLowerCase().includes(needle));
    }
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      out = out.filter((e) => {
        const hay = [e.tool, e.action, e.target, e.summary, e.client, e.session_id]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }
    return out;
  }

  router.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const entries = filterActivity(getRecentActivity(limit, since), {
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      tool: typeof req.query.tool === "string" ? req.query.tool : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
    });
    res.json({ ok: true, entries, count: entries.length });
  });

  router.get("/api/activity/history", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "80"), 10) || 80, 500);
      const entries = await loadAuditHistory(limit);
      res.json({ ok: true, entries, source: "audit_file" });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/activity/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (entry: ActivityEntry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    for (const entry of getRecentActivity(30).reverse()) send(entry);

    const unsub = subscribeActivity(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      unsub();
      clearInterval(ping);
    });
  });

  return router;
}
