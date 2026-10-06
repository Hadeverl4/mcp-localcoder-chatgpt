import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface CompletedResultCacheEntry {
  version: 1;
  command: string;
  cwd: string;
  workspace_fingerprint: string;
  stdout: string;
  stderr: string;
  exit_code: 0;
  cached_at: string;
}

const MAX_CACHED_OUTPUT_CHARS = 200_000;

function cacheEnabled(): boolean {
  const raw = (process.env.MCP_COMPLETED_RESULT_CACHE ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function stateRoot(): string {
  return process.env.MCP_SHELL_STATE_DIR || path.join(process.cwd(), ".mcp-state");
}

function cacheRoot(): string {
  return path.join(stateRoot(), "completed-results");
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function normalizeCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function cacheKey(command: string, cwd: string): string {
  return createHash("sha256")
    .update(`${normalizeCwd(cwd)}\n${normalizeCommand(command)}`)
    .digest("hex");
}

function cachePath(command: string, cwd: string): string {
  return path.join(cacheRoot(), `${cacheKey(command, cwd)}.json`);
}

export function isReusableCompletedCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized || /[;&|><\r\n]/.test(normalized)) return false;

  const patterns = [
    /^cargo (?:test|check|build|clippy|bench)(?:\s+.*)?$/i,
    /^npm test(?:\s+.*)?$/i,
    /^npm run (?:build|check|typecheck|lint|test)(?:\s+.*)?$/i,
    /^pnpm (?:test|build|check|lint)(?:\s+.*)?$/i,
    /^yarn (?:test|build|check|lint)(?:\s+.*)?$/i,
    /^dotnet (?:build|test)(?:\s+.*)?$/i,
    /^(?:mvn|mvnw|gradle|gradlew)(?:\s+.*)?\b(?:test|build|package|assemble|check)\b(?:\s+.*)?$/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export async function loadCompletedResult(
  command: string,
  cwd: string,
  workspaceFingerprint: string
): Promise<CompletedResultCacheEntry | null> {
  if (!cacheEnabled() || !isReusableCompletedCommand(command)) return null;
  try {
    const raw = await fs.readFile(cachePath(command, cwd), "utf-8");
    const entry = JSON.parse(raw) as CompletedResultCacheEntry;
    if (
      entry?.version !== 1 ||
      entry.exit_code !== 0 ||
      entry.workspace_fingerprint !== workspaceFingerprint ||
      normalizeCwd(entry.cwd) !== normalizeCwd(cwd) ||
      normalizeCommand(entry.command) !== normalizeCommand(command)
    ) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export async function saveCompletedResult(input: {
  command: string;
  cwd: string;
  workspace_fingerprint: string;
  stdout: string;
  stderr: string;
}): Promise<CompletedResultCacheEntry | null> {
  if (!cacheEnabled() || !isReusableCompletedCommand(input.command)) return null;
  try {
    const entry: CompletedResultCacheEntry = {
      version: 1,
      command: input.command,
      cwd: path.resolve(input.cwd),
      workspace_fingerprint: input.workspace_fingerprint,
      stdout: input.stdout.slice(-MAX_CACHED_OUTPUT_CHARS),
      stderr: input.stderr.slice(-MAX_CACHED_OUTPUT_CHARS),
      exit_code: 0,
      cached_at: new Date().toISOString(),
    };
    const target = cachePath(input.command, input.cwd);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(entry), "utf-8");
    await fs.rename(temp, target);
    return entry;
  } catch {
    return null;
  }
}