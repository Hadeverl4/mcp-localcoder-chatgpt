import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ContinuationStatus = "ok" | "error";

export interface ContinuationToolCall {
  time: string;
  tool: string;
  status: ContinuationStatus;
  summary: string;
  args: Record<string, string | number | boolean | null>;
}

const STATE_DIR = process.env.MCP_SHELL_STATE_DIR || path.join(process.cwd(), ".mcp-state");
const configuredMaxHistory = Number(process.env.MCP_CONTINUATION_HISTORY_MAX || 12);
const MAX_HISTORY = Number.isFinite(configuredMaxHistory)
  ? Math.max(4, Math.min(50, Math.floor(configuredMaxHistory)))
  : 12;
const writeQueues = new Map<string, Promise<void>>();

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function statePath(workspaceRoot: string): string {
  return path.join(STATE_DIR, `continuation-${workspaceKey(workspaceRoot)}.json`);
}

function trim(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function compactContinuationArgs(
  tool: string,
  args: unknown
): Record<string, string | number | boolean | null> {
  if (!args || typeof args !== "object") return {};
  const source = args as Record<string, unknown>;
  const compact: Record<string, string | number | boolean | null> = {};
  const scalarKeys = [
    "path",
    "working_directory",
    "dry_run",
    "action",
    "checkpoint_id",
    "id",
    "force",
    "pattern",
    "glob",
    "staged",
    "file",
    "server_id",
  ];

  for (const key of scalarKeys) {
    const value = source[key];
    if (typeof value === "string") compact[key] = trim(value, key === "pattern" ? 180 : 260);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) compact[key] = value;
  }

  if (typeof source.command === "string") compact.command = trim(source.command, 300);
  if (tool === "read_many" && Array.isArray(source.files)) {
    const paths = source.files
      .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).path : undefined))
      .filter((value): value is string => typeof value === "string")
      .slice(0, 6);
    if (paths.length > 0) compact.files = trim(paths.join(" | "), 500);
  }

  return compact;
}

async function readState(workspaceRoot: string): Promise<ContinuationToolCall[]> {
  try {
    const raw = await fs.readFile(statePath(workspaceRoot), "utf-8");
    const parsed = JSON.parse(raw) as { calls?: ContinuationToolCall[] };
    return Array.isArray(parsed.calls) ? parsed.calls : [];
  } catch {
    return [];
  }
}

export async function loadContinuationToolCalls(
  workspaceRoot: string,
  limit = 8
): Promise<ContinuationToolCall[]> {
  const calls = await readState(workspaceRoot);
  return calls.slice(-Math.max(1, Math.min(limit, MAX_HISTORY)));
}

export function appendContinuationToolCall(
  workspaceRoot: string,
  input: {
    tool: string;
    status: ContinuationStatus;
    summary?: string;
    args?: unknown;
    time?: string;
  }
): Promise<void> {
  const file = statePath(workspaceRoot);
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const calls = await readState(workspaceRoot);
    calls.push({
      time: input.time ?? new Date().toISOString(),
      tool: input.tool,
      status: input.status,
      summary: trim(input.summary || input.tool, 240),
      args: compactContinuationArgs(input.tool, input.args),
    });
    const bounded = calls.slice(-MAX_HISTORY);
    await fs.mkdir(STATE_DIR, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ calls: bounded }, null, 2), "utf-8");
    await fs.rename(temp, file);
  });
  writeQueues.set(file, next);
  return next;
}