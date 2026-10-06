import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import {
  applyCwdDirectives,
  bootstrapShellSession,
  getShellStatus,
  prepareShellCommand,
  resetShellSession,
} from "../lib/persistent-shell.js";
import {
  buildProcessDedupeKey,
  clearFinishedManagedProcesses,
  findRunningHeavyProcess,
  getManagedProcess,
  isLikelyHeavyCommand,
  listManagedProcesses,
  managedProcessRunning,
  markManagedProcessResultCached,
  observeManagedProcess,
  snapshotManagedProcess,
  startManagedProcess,
  stopManagedProcess,
  waitForManagedProcess,
} from "../lib/managed-process.js";
import { getWorkspaceFingerprint } from "../lib/workspace-fingerprint.js";
import {
  isReusableCompletedCommand,
  loadCompletedResult,
  saveCompletedResult,
} from "../lib/completed-result-cache.js";
import {
  createBatchId,
  loadBatchResumeState,
  saveProcessResumeState,
  saveBatchResumeState,
} from "../lib/batch-resume-state.js";
import { loadContinuationToolCalls } from "../lib/continuation-state.js";

const DEFAULT_SYNC_WAIT_MS = 8_000;

function syncWaitMs(timeoutSec: number): number {
  const configured = Number(process.env.MCP_RUN_COMMAND_SYNC_MS || DEFAULT_SYNC_WAIT_MS);
  const safeConfigured = Number.isFinite(configured) ? configured : DEFAULT_SYNC_WAIT_MS;
  return Math.max(500, Math.min(safeConfigured, timeoutSec * 1000, 30_000));
}

function runCommandRetryKey(command: string, cwd: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return `run_command\n${process.platform === "win32" ? cwd.toLowerCase() : cwd}\n${normalized}`;
}

function commandCwd(workingDirectory: string | undefined, defaultCwd: string): string {
  return workingDirectory || getShellStatus().cwd || defaultCwd;
}

async function persistProcessResumeState(
  workspaceRoot: string,
  item: NonNullable<ReturnType<typeof getManagedProcess>>,
  status: "running" | "completed" | "failed",
  nextPollMs: number
): Promise<void> {
  await saveProcessResumeState(workspaceRoot, {
    batch_id: `batch-${item.id}`,
    cwd: item.cwd,
    command: item.command,
    process_id: item.id,
    status,
    started_at: item.startedAt,
    exit_code: item.exitCode,
    next_poll_ms: nextPollMs,
    blocked_by_process_id: null,
  });
}

async function cacheSuccessfulProcess(
  item: NonNullable<ReturnType<typeof getManagedProcess>>,
  stdout: string,
  stderr: string
): Promise<boolean> {
  if (
    item.exitCode !== 0 ||
    !item.workspaceFingerprint ||
    item.resultCached ||
    !isReusableCompletedCommand(item.command)
  ) {
    return false;
  }
  const saved = await saveCompletedResult({
    command: item.command,
    cwd: item.cwd,
    workspace_fingerprint: item.workspaceFingerprint,
    stdout,
    stderr,
  });
  if (!saved) return false;
  markManagedProcessResultCached(item);
  return true;
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number): void {
  void bootstrapShellSession(defaultCwd);

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Run a shell command. Quick commands return normally; commands still running after a short wait automatically continue in the background and return a process id for process_output. Identical in-flight retries are deduplicated.",
      inputSchema: {
        command: z.string(),
        working_directory: z.string().optional().describe("One-off override; does not reset persistent cwd unless you use shell_reset"),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwdOverride = working_directory ? await validatePath(working_directory) : undefined;
      const baseCwd = commandCwd(cwdOverride, defaultCwd);
      const preview = applyCwdDirectives(baseCwd, command);
      const candidateCwd = preview.cwd;
      const retryKey = runCommandRetryKey(preview.command, candidateCwd);
      const existing = listManagedProcesses().find(
        (item) => item.dedupeKey === retryKey && managedProcessRunning(item)
      );

      if (existing) {
        const data = {
          ...snapshotManagedProcess(existing, 4_000),
          backgrounded: true,
          deduplicated: true,
          poll_with: "process_output",
          next_poll_ms: 2_000,
          next_poll_at: new Date(Date.now() + 2_000).toISOString(),
        };
        await persistProcessResumeState(defaultCwd, existing, "running", 2_000);
        await audit({
          tool: "run_command",
          action: "reuse_background",
          target: existing.cwd,
          status: "ok",
          details: { command, id: existing.id, deduplicated: true },
        });
        return toolResult("run_command", data, {
          summary: `reused running process ${existing.id}; poll process_output`,
        });
      }

      let workspaceFingerprint: string | null = null;
      if (isReusableCompletedCommand(preview.command)) {
        const workspace = await getWorkspaceFingerprint(candidateCwd);
        workspaceFingerprint = workspace?.fingerprint ?? null;
        if (workspaceFingerprint) {
          const cached = await loadCompletedResult(
            preview.command,
            candidateCwd,
            workspaceFingerprint
          );
          if (cached) {
            const prepared = await prepareShellCommand(command, defaultCwd, cwdOverride);
            const result = {
              command: prepared.command,
              cwd: prepared.cwd,
              stdout: cached.stdout,
              stderr: cached.stderr,
              exit_code: 0,
              timed_out: false,
              reused_completed: true,
              workspace_fingerprint: workspaceFingerprint,
              cached_at: cached.cached_at,
            };
            await audit({
              tool: "run_command",
              action: "reuse_completed",
              target: prepared.cwd,
              status: "ok",
              details: {
                command: prepared.command,
                workspace_fingerprint: workspaceFingerprint,
                cached_at: cached.cached_at,
              },
            });
            return toolResult("run_command", result, {
              summary: `reused completed result in ${prepared.cwd}`,
            });
          }
        }
      }

      if (isLikelyHeavyCommand(command)) {
        const blocker = findRunningHeavyProcess(candidateCwd, retryKey);
        if (blocker) {
          const batchId = createBatchId(candidateCwd, command);
          await saveBatchResumeState(defaultCwd, {
            batch_id: batchId,
            cwd: candidateCwd,
            command,
            process_id: null,
            status: "deferred",
            started_at: new Date().toISOString(),
            exit_code: null,
            next_poll_ms: 5_000,
            blocked_by_process_id: blocker.id,
          });
          await audit({
            tool: "run_command",
            action: "deferred",
            target: candidateCwd,
            status: "ok",
            details: { command, blocked_by_process_id: blocker.id, reason: "heavy_command_concurrency_limit" },
          });
          return toolResult("run_command", {
            command,
            cwd: candidateCwd,
            deferred: true,
            reason: "heavy_command_concurrency_limit",
            blocked_by_process_id: blocker.id,
            retry_after_ms: 5_000,
            poll_blocker_with: "process_output",
            batch_id: batchId,
          }, {
            summary: `deferred; heavy process ${blocker.id} is already running`,
          });
        }
      }

      const prepared = await prepareShellCommand(command, defaultCwd, cwdOverride);
      const started = startManagedProcess(prepared.command, prepared.cwd, {
        dedupeKey: retryKey,
        dedupe: true,
        stabilityClass: isLikelyHeavyCommand(command) ? "heavy" : "normal",
        workspaceFingerprint,
      });
      const waitMs = syncWaitMs(timeoutSec);
      const completed = started.deduplicated
        ? false
        : await waitForManagedProcess(started.process, waitMs);

      if (!completed) {
        const data = {
          ...snapshotManagedProcess(started.process, 4_000),
          backgrounded: true,
          deduplicated: started.deduplicated,
          sync_wait_ms: waitMs,
          poll_with: "process_output",
          next_poll_ms: 2_000,
          next_poll_at: new Date(Date.now() + 2_000).toISOString(),
        };
        await persistProcessResumeState(defaultCwd, started.process, "running", 2_000);
        await audit({
          tool: "run_command",
          action: "background",
          target: started.process.cwd,
          status: "ok",
          details: {
            command,
            id: started.process.id,
            deduplicated: started.deduplicated,
            sync_wait_ms: waitMs,
          },
        });
        return toolResult("run_command", data, {
          summary: `backgrounded ${started.process.id}; poll process_output`,
        });
      }

      const snapshot = snapshotManagedProcess(started.process, 400_000);
      const result = {
        command: prepared.command,
        cwd: prepared.cwd,
        stdout: snapshot.stdout.trim(),
        stderr: snapshot.stderr.trim(),
        exit_code: snapshot.exit_code,
        timed_out: false,
        reused_completed: false,
        workspace_fingerprint: started.process.workspaceFingerprint,
      };
      if (result.exit_code === 0) {
        await cacheSuccessfulProcess(started.process, snapshot.stdout, snapshot.stderr);
      }
      await persistProcessResumeState(
        defaultCwd,
        started.process,
        result.exit_code === 0 ? "completed" : "failed",
        0
      );
      await audit({
        tool: "run_command",
        action: "command",
        target: result.cwd,
        status: result.exit_code === 0 ? "ok" : "error",
        details: { command, exit_code: result.exit_code },
      });
      return toolResult("run_command", result, {
        ok: result.exit_code === 0,
        summary: `exit ${result.exit_code} in ${result.cwd}`,
      });
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show persistent shell cwd, resumable process state, and recent continuation trail.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const status = getShellStatus();
      const persisted = await loadBatchResumeState(defaultCwd);
      const continuationTrail = await loadContinuationToolCalls(defaultCwd, 8);
      let resumeState = persisted;
      if (persisted?.process_id) {
        const item = getManagedProcess(persisted.process_id);
        if (item) {
          const live = snapshotManagedProcess(item, 2_000);
          resumeState = {
            ...persisted,
            status: live.running ? "running" : live.exit_code === 0 ? "completed" : "failed",
            exit_code: live.exit_code,
            next_poll_ms: live.running ? Math.max(2_000, persisted.next_poll_ms || 0) : 0,
            updated_at: new Date().toISOString(),
          };
        } else if (persisted.status === "running") {
          resumeState = { ...persisted, status: "stale", next_poll_ms: 0 };
        }
      } else if (persisted?.status === "deferred" && persisted.blocked_by_process_id) {
        const blocker = getManagedProcess(persisted.blocked_by_process_id);
        if (blocker && !managedProcessRunning(blocker)) {
          resumeState = { ...persisted, status: "ready", next_poll_ms: 0, updated_at: new Date().toISOString() };
        } else if (!blocker) {
          resumeState = { ...persisted, status: "stale", next_poll_ms: 0, updated_at: new Date().toISOString() };
        }
      }
      return toolResult("shell_status", {
        ...status,
        resume_state: resumeState,
        continuation_trail: continuationTrail,
      }, {
        summary: resumeState?.status === "running"
          ? `cwd: ${status.cwd}; resumable process ${resumeState.process_id}`
          : continuationTrail.length > 0
            ? `cwd: ${status.cwd}; last tool ${continuationTrail.at(-1)?.tool}`
            : `cwd: ${status.cwd}`,
      });
    }
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Shell Reset",
      description: "Reset persistent shell cwd to a directory (default: workspace).",
      inputSchema: { path: z.string().optional() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      const cwd = dirPath ? await validatePath(dirPath) : defaultCwd;
      resetShellSession(cwd);
      return toolResult("shell_reset", { cwd }, { summary: `shell cwd reset to ${cwd}` });
    }
  );

  server.registerTool(
    "start_process",
    {
      title: "Start Background Process",
      description: "Start a long-running command in the background. Use process_output/process_status/stop_process afterwards.",
      inputSchema: { command: z.string(), working_directory: z.string().optional() },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwd = working_directory ? await validatePath(working_directory) : getShellStatus().cwd || defaultCwd;
      const dedupeKey = buildProcessDedupeKey(command, cwd);
      const exact = listManagedProcesses().find(
        (item) => item.dedupeKey === dedupeKey && managedProcessRunning(item)
      );
      if (!exact && isLikelyHeavyCommand(command)) {
        const blocker = findRunningHeavyProcess(cwd, dedupeKey);
        if (blocker) {
          const batchId = createBatchId(cwd, command);
          await saveBatchResumeState(defaultCwd, {
            batch_id: batchId,
            cwd,
            command,
            process_id: null,
            status: "deferred",
            started_at: new Date().toISOString(),
            exit_code: null,
            next_poll_ms: 5_000,
            blocked_by_process_id: blocker.id,
          });
          await audit({
            tool: "start_process",
            action: "deferred",
            target: cwd,
            status: "ok",
            details: { command, blocked_by_process_id: blocker.id, reason: "heavy_command_concurrency_limit" },
          });
          return toolResult("start_process", {
            command,
            cwd,
            deferred: true,
            reason: "heavy_command_concurrency_limit",
            blocked_by_process_id: blocker.id,
            retry_after_ms: 5_000,
            batch_id: batchId,
          }, { summary: `deferred; heavy process ${blocker.id} is already running` });
        }
      }
      const started = startManagedProcess(command, cwd, {
        dedupeKey,
        dedupe: true,
        stabilityClass: isLikelyHeavyCommand(command) ? "heavy" : "normal",
      });
      const item = started.process;
      await persistProcessResumeState(defaultCwd, item, "running", 2_000);
      await audit({
        tool: "start_process",
        action: started.deduplicated ? "reuse" : "start",
        target: cwd,
        status: "ok",
        details: { id: item.id, command, deduplicated: started.deduplicated },
      });
      return toolResult("start_process", {
        id: item.id,
        pid: item.pid,
        command,
        cwd,
        started_at: item.startedAt,
        deduplicated: started.deduplicated,
        next_poll_ms: 2_000,
        next_poll_at: new Date(Date.now() + 2_000).toISOString(),
      }, {
        summary: started.deduplicated ? `reused ${item.id}` : `started ${item.id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      title: "Process Status",
      description: "Show status of background process(es).",
      inputSchema: { id: z.string().optional() },

      annotations: toolAnnotations("read"),
    },
    async ({ id }) => {
      const processes_list = listManagedProcesses()
        .filter((p) => !id || p.id === id)
        .map((p) => ({
          id: p.id,
          pid: p.pid,
          command: p.command,
          cwd: p.cwd,
          started_at: p.startedAt,
          running: managedProcessRunning(p),
          exit_code: p.exitCode,
          signal: p.signal,
        }));
      return toolResult("process_status", { processes: processes_list }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      title: "Process Output",
      description: "Read stdout/stderr logs for a background process. Respect next_poll_ms to avoid excessive polling.",
      inputSchema: {
        id: z.string(),
        tail_chars: z.number().int().positive().max(200000).optional().default(40000),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, tail_chars }) => {
      const item = getManagedProcess(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      const data = observeManagedProcess(item, tail_chars);
      if (!data.running && data.exit_code === 0) {
        await cacheSuccessfulProcess(item, data.stdout, data.stderr);
      }
      await persistProcessResumeState(
        defaultCwd,
        item,
        data.running ? "running" : data.exit_code === 0 ? "completed" : "failed",
        data.next_poll_ms
      );
      return toolResult("process_output", data, { summary: `output for ${id}` });
    }
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop Process",
      description: "Stop a background process by id.",
      inputSchema: { id: z.string(), force: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ id, force }) => {
      const item = getManagedProcess(id);
      if (!item) throw new Error(`Unknown process id: ${id}`);
      if (!managedProcessRunning(item)) {
        return toolResult("stop_process", { id, already_exited: true }, { summary: `${id} already exited` });
      }
      const stopped = stopManagedProcess(item, force);
      await audit({ tool: "stop_process", action: "stop", target: item.cwd, status: "ok", details: { id, force } });
      return toolResult("stop_process", { id, force, stopped }, { summary: stopped ? `stop sent to ${id}` : `unable to stop ${id}` });
    }
  );

  server.registerTool(
    "clear_processes",
    {
      title: "Clear Finished Processes",
      description: "Remove finished process records from memory.",
      inputSchema: {},

      annotations: toolAnnotations("edit"),
    },
    async () => {
      const cleared = clearFinishedManagedProcesses();
      return toolResult("clear_processes", { cleared }, { summary: `cleared ${cleared}` });
    }
  );
}