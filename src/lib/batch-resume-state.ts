import { createHash } from "node:crypto";
import fs from "fs/promises";
import path from "path";

export type BatchResumeStatus = "running" | "deferred" | "ready" | "completed" | "failed" | "stale";

export interface BatchResumeState {
  batch_id: string;
  workspace_key: string;
  cwd: string;
  command: string;
  process_id: string | null;
  status: BatchResumeStatus;
  started_at: string;
  updated_at: string;
  exit_code: number | null;
  next_poll_ms: number;
  blocked_by_process_id: string | null;
}

const STATE_DIR = process.env.MCP_SHELL_STATE_DIR || path.join(process.cwd(), ".mcp-state");

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function statePath(workspaceRoot: string): string {
  return path.join(STATE_DIR, `batch-${workspaceKey(workspaceRoot)}.json`);
}

export function createBatchId(cwd: string, command: string, seed = Date.now().toString()): string {
  const digest = createHash("sha256")
    .update(`${path.resolve(cwd)}\n${command.trim()}\n${seed}`)
    .digest("hex")
    .slice(0, 12);
  return `batch-${digest}`;
}

export async function loadBatchResumeState(workspaceRoot: string): Promise<BatchResumeState | null> {
  try {
    const raw = await fs.readFile(statePath(workspaceRoot), "utf-8");
    const state = JSON.parse(raw) as BatchResumeState;
    if (!state?.batch_id || !state?.cwd || !state?.command) return null;
    return state;
  } catch {
    return null;
  }
}

export async function saveBatchResumeState(
  workspaceRoot: string,
  state: Omit<BatchResumeState, "workspace_key" | "updated_at">
): Promise<BatchResumeState> {
  const stored: BatchResumeState = {
    ...state,
    workspace_key: workspaceKey(workspaceRoot),
    updated_at: new Date().toISOString(),
  };
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(statePath(workspaceRoot), JSON.stringify(stored, null, 2), "utf-8");
  return stored;
}

export async function saveProcessResumeState(
  workspaceRoot: string,
  state: Omit<BatchResumeState, "workspace_key" | "updated_at">
): Promise<BatchResumeState> {
  const current = await loadBatchResumeState(workspaceRoot);
  if (
    current?.status === "deferred" &&
    current.process_id === null &&
    current.blocked_by_process_id &&
    current.blocked_by_process_id === state.process_id
  ) {
    return current;
  }
  return saveBatchResumeState(workspaceRoot, state);
}