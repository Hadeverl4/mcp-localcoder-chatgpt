import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getWinShell, transpileCompoundOperators } from "./persistent-shell.js";

export interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcess | null;
  pid: number | null;
  stateDir: string;
  stdoutPath: string;
  stderrPath: string;
  exitPath: string;
  metaPath: string;
  stdoutChars: number;
  stderrChars: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finishedAt: number | null;
  dedupeKey: string;
  stabilityClass: "normal" | "heavy";
  pollCount: number;
  unchangedPollCount: number;
  lastObservedOutputChars: number;
  workspaceFingerprint: string | null;
  resultCached: boolean;
}

export interface StartManagedProcessResult {
  process: ManagedProcess;
  deduplicated: boolean;
}

const processes = new Map<string, ManagedProcess>();
const MAX_LOG_CHARS = 400_000;
const DEFAULT_FINISHED_RETENTION_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 200;
const loadedStateRoots = new Set<string>();

function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: "true",
    PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    npm_config_yes: "true",
  };
}

interface PersistedManagedProcess {
  version: 1;
  id: string;
  command: string;
  cwd: string;
  started_at: string;
  pid: number | null;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  finished_at: number | null;
  dedupe_key: string;
  stability_class: "normal" | "heavy";
  workspace_fingerprint: string | null;
  result_cached: boolean;
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function normalizeCwd(cwd: string): string {
  return process.platform === "win32" ? cwd.toLowerCase() : cwd;
}

export function buildProcessDedupeKey(command: string, cwd: string): string {
  return `${normalizeCwd(cwd)}\n${normalizeCommand(command)}`;
}

export function isLikelyHeavyCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  const patterns = [
    /\bcargo\s+(?:test|check|build|clippy|bench)\b/i,
    /\bnpm\s+(?:test|ci|install)\b/i,
    /\bnpm\s+run\s+(?:build|check|typecheck|lint|test|tauri(?::[^\s;|&]+)?)\b/i,
    /\bpnpm\s+(?:test|build|check|install|lint|run)\b/i,
    /\byarn\s+(?:test|build|check|install|lint|run)\b/i,
    /\b(?:npx\s+)?tauri\s+build\b/i,
    /\bdotnet\s+(?:build|test|publish)\b/i,
    /\b(?:mvn|mvnw|gradle|gradlew)\b[^\r\n]*(?:test|build|package|assemble|check)\b/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function processStateRoot(): string {
  if (process.env.MCP_PROCESS_STATE_DIR) return path.resolve(process.env.MCP_PROCESS_STATE_DIR);
  const shellStateRoot = process.env.MCP_SHELL_STATE_DIR || path.join(process.cwd(), ".mcp-state");
  return path.join(shellStateRoot, "processes");
}

function pathsFor(root: string, id: string) {
  const stateDir = path.join(root, id);
  return {
    stateDir,
    stdoutPath: path.join(stateDir, "stdout.log"),
    stderrPath: path.join(stateDir, "stderr.log"),
    exitPath: path.join(stateDir, "exit.code"),
    metaPath: path.join(stateDir, "meta.json"),
    scriptPath: path.join(stateDir, process.platform === "win32" ? "command.ps1" : "command.sh"),
    workerPath: path.join(stateDir, "worker.cjs"),
  };
}

function persistedShape(item: ManagedProcess): PersistedManagedProcess {
  return {
    version: 1,
    id: item.id,
    command: item.command,
    cwd: item.cwd,
    started_at: item.startedAt,
    pid: item.pid,
    exit_code: item.exitCode,
    signal: item.signal,
    finished_at: item.finishedAt,
    dedupe_key: item.dedupeKey,
    stability_class: item.stabilityClass,
    workspace_fingerprint: item.workspaceFingerprint,
    result_cached: item.resultCached,
  };
}

function persistMetadata(item: ManagedProcess): void {
  try {
    fs.mkdirSync(item.stateDir, { recursive: true });
    const temp = `${item.metaPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(persistedShape(item)), "utf-8");
    fs.renameSync(temp, item.metaPath);
  } catch {
    // Process execution must not fail solely because persistence metadata could not be updated.
  }
}

function logSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readLogTail(filePath: string, tailChars: number): string {
  try {
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, tailChars);
    if (length <= 0) return "";
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      return buffer.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function appendErrorLog(item: ManagedProcess, message: string): void {
  try {
    fs.appendFileSync(item.stderrPath, message.endsWith("\n") ? message : `${message}\n`, "utf-8");
  } catch {}
}

function trimCompletedLog(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_LOG_CHARS) return;
    const tail = readLogTail(filePath, MAX_LOG_CHARS);
    fs.writeFileSync(filePath, tail, "utf-8");
  } catch {}
}

function pidIsAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readPersistedExitCode(item: ManagedProcess): number | null {
  try {
    const raw = fs.readFileSync(item.exitPath, "utf-8").trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

function finishManagedProcess(
  item: ManagedProcess,
  exitCode: number,
  signal: NodeJS.Signals | null = null
): void {
  if (item.exitCode !== null || item.signal !== null) return;
  item.exitCode = exitCode;
  item.signal = signal;
  item.finishedAt = Date.now();
  trimCompletedLog(item.stdoutPath);
  trimCompletedLog(item.stderrPath);
  item.stdoutChars = logSize(item.stdoutPath);
  item.stderrChars = logSize(item.stderrPath);
  persistMetadata(item);
}

function refreshManagedProcess(item: ManagedProcess): void {
  if (item.exitCode !== null || item.signal !== null) return;
  const persistedExit = readPersistedExitCode(item);
  if (persistedExit !== null) {
    finishManagedProcess(item, persistedExit, null);
    return;
  }
  if (item.child?.exitCode !== null && item.child?.exitCode !== undefined) {
    finishManagedProcess(item, item.child.exitCode, item.child.signalCode as NodeJS.Signals | null);
    return;
  }
  if (item.pid !== null && !pidIsAlive(item.pid)) {
    finishManagedProcess(item, -1, null);
  }
}

function loadPersistedProcesses(): void {
  const root = processStateRoot();
  if (loadedStateRoots.has(root)) return;
  loadedStateRoots.add(root);
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = pathsFor(root, entry.name);
      try {
        const meta = JSON.parse(fs.readFileSync(files.metaPath, "utf-8")) as PersistedManagedProcess;
        if (meta?.version !== 1 || !meta.id || !meta.cwd || !meta.command) continue;
        if (processes.has(meta.id)) continue;
        const item: ManagedProcess = {
          id: meta.id,
          command: meta.command,
          cwd: meta.cwd,
          startedAt: meta.started_at,
          child: null,
          pid: meta.pid,
          stateDir: files.stateDir,
          stdoutPath: files.stdoutPath,
          stderrPath: files.stderrPath,
          exitPath: files.exitPath,
          metaPath: files.metaPath,
          stdoutChars: logSize(files.stdoutPath),
          stderrChars: logSize(files.stderrPath),
          exitCode: meta.exit_code,
          signal: meta.signal,
          finishedAt: meta.finished_at,
          dedupeKey: meta.dedupe_key,
          stabilityClass: meta.stability_class,
          pollCount: 0,
          unchangedPollCount: 0,
          lastObservedOutputChars: 0,
          workspaceFingerprint: meta.workspace_fingerprint ?? null,
          resultCached: meta.result_cached ?? false,
        };
        processes.set(item.id, item);
        refreshManagedProcess(item);
      } catch {}
    }
  } catch {}
}

function isRunning(item: ManagedProcess): boolean {
  refreshManagedProcess(item);
  return item.exitCode === null && item.signal === null;
}

export function findRunningProcessByKey(dedupeKey: string): ManagedProcess | undefined {
  loadPersistedProcesses();
  for (const item of processes.values()) {
    if (item.dedupeKey === dedupeKey && isRunning(item)) return item;
  }
  return undefined;
}

export function startManagedProcess(
  command: string,
  cwd: string,
  options: {
    dedupeKey?: string;
    dedupe?: boolean;
    stabilityClass?: "normal" | "heavy";
    workspaceFingerprint?: string | null;
  } = {}
): StartManagedProcessResult {
  loadPersistedProcesses();
  pruneManagedProcesses();
  const dedupeKey = options.dedupeKey ?? buildProcessDedupeKey(command, cwd);
  if (options.dedupe !== false) {
    const existing = findRunningProcessByKey(dedupeKey);
    if (existing) return { process: existing, deduplicated: true };
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const files = pathsFor(processStateRoot(), id);
  fs.mkdirSync(files.stateDir, { recursive: true });
  fs.writeFileSync(files.stdoutPath, "");
  fs.writeFileSync(files.stderrPath, "");
  try {
    fs.rmSync(files.exitPath, { force: true });
  } catch {}

  const item: ManagedProcess = {
    id,
    command,
    cwd,
    startedAt: new Date().toISOString(),
    child: null,
    pid: null,
    stateDir: files.stateDir,
    stdoutPath: files.stdoutPath,
    stderrPath: files.stderrPath,
    exitPath: files.exitPath,
    metaPath: files.metaPath,
    stdoutChars: 0,
    stderrChars: 0,
    exitCode: null,
    signal: null,
    finishedAt: null,
    dedupeKey,
    stabilityClass: options.stabilityClass ?? (isLikelyHeavyCommand(command) ? "heavy" : "normal"),
    pollCount: 0,
    unchangedPollCount: 0,
    lastObservedOutputChars: 0,
    workspaceFingerprint: options.workspaceFingerprint ?? null,
    resultCached: false,
  };

  processes.set(id, item);
  persistMetadata(item);

  const winShell = process.platform === "win32" ? getWinShell() : null;
  const effectiveCommand =
    winShell && !winShell.isPwsh ? transpileCompoundOperators(command) : command;
  const script =
    process.platform === "win32"
      ? `${effectiveCommand}\nif ($null -ne $LASTEXITCODE) { exit [int]$LASTEXITCODE }\nif (-not $?) { exit 1 }\nexit 0\n`
      : `#!/usr/bin/env bash\n${effectiveCommand}\n`;
  fs.writeFileSync(files.scriptPath, script, "utf-8");

  try {
    let child: ChildProcess;
    if (process.platform === "win32") {
      const workerScript = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const [shellPath, jobPath, stdoutPath, stderrPath, exitPath, cwd] = process.argv.slice(2);',
        'let stdoutFd = null;',
        'let stderrFd = null;',
        'try {',
        '  stdoutFd = fs.openSync(stdoutPath, "a");',
        '  stderrFd = fs.openSync(stderrPath, "a");',
        '  const command = spawn(shellPath, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", jobPath], {',
        '    cwd,',
        '    windowsHide: true,',
        '    stdio: ["ignore", stdoutFd, stderrFd],',
        '  });',
        '  fs.closeSync(stdoutFd); stdoutFd = null;',
        '  fs.closeSync(stderrFd); stderrFd = null;',
        '  command.on("error", (error) => {',
        '    try { fs.appendFileSync(stderrPath, String(error?.stack || error) + "\\n", "utf-8"); } catch {}',
        '    try { fs.writeFileSync(exitPath, "-1", "utf-8"); } catch {}',
        '    process.exit(1);',
        '  });',
        '  command.on("close", (code) => {',
        '    try { fs.writeFileSync(exitPath, String(code ?? -1), "utf-8"); } catch {}',
        '    process.exit(0);',
        '  });',
        '} catch (error) {',
        '  if (stdoutFd !== null) { try { fs.closeSync(stdoutFd); } catch {} }',
        '  if (stderrFd !== null) { try { fs.closeSync(stderrFd); } catch {} }',
        '  try { fs.appendFileSync(stderrPath, String(error?.stack || error) + "\\n", "utf-8"); } catch {}',
        '  try { fs.writeFileSync(exitPath, "-1", "utf-8"); } catch {}',
        '  process.exit(1);',
        '}',
        "",
      ].join("\n");
      fs.writeFileSync(files.workerPath, workerScript, "utf-8");
      child = spawn(
        process.execPath,
        [files.workerPath, winShell?.shell || "powershell.exe", files.scriptPath, files.stdoutPath, files.stderrPath, files.exitPath, cwd],
        {
          cwd,
          windowsHide: true,
          detached: true,
          stdio: "ignore",
          env: commandEnvironment(),
        }
      );
    } else {
      const stdoutFd = fs.openSync(files.stdoutPath, "a");
      const stderrFd = fs.openSync(files.stderrPath, "a");
      try {
        child = spawn(
          "bash",
          [
            "-lc",
            "bash \"$MCP_MANAGED_SCRIPT_PATH\"; code=$?; printf '%s' \"$code\" > \"$MCP_MANAGED_EXIT_PATH\"; exit \"$code\"",
          ],
          {
            cwd,
            windowsHide: true,
            env: {
              ...commandEnvironment(),
              MCP_MANAGED_SCRIPT_PATH: files.scriptPath,
              MCP_MANAGED_EXIT_PATH: files.exitPath,
            },
            detached: true,
            stdio: ["ignore", stdoutFd, stderrFd],
          }
        );
      } finally {
        try { fs.closeSync(stdoutFd); } catch {}
        try { fs.closeSync(stderrFd); } catch {}
      }
    }
    item.child = child;
    item.pid = child.pid ?? null;
    persistMetadata(item);
    child.on("close", (code, signal) => {
      const persistedExit = readPersistedExitCode(item);
      finishManagedProcess(item, persistedExit ?? code ?? -1, signal as NodeJS.Signals | null);
    });
    child.on("error", (error) => {
      appendErrorLog(item, error.message);
      finishManagedProcess(item, -1, null);
    });
    child.unref();
  } catch (error) {
    appendErrorLog(item, error instanceof Error ? error.message : String(error));
    finishManagedProcess(item, -1, null);
  }

  return { process: item, deduplicated: false };
}

export function getManagedProcess(id: string): ManagedProcess | undefined {
  loadPersistedProcesses();
  return processes.get(id);
}

export function listManagedProcesses(): ManagedProcess[] {
  loadPersistedProcesses();
  return [...processes.values()];
}

export function findRunningHeavyProcess(cwd: string, excludeDedupeKey?: string): ManagedProcess | undefined {
  loadPersistedProcesses();
  const normalizedCwd = normalizeCwd(cwd);
  return [...processes.values()].find(
    (item) =>
      isRunning(item) &&
      item.stabilityClass === "heavy" &&
      normalizeCwd(item.cwd) === normalizedCwd &&
      (!excludeDedupeKey || item.dedupeKey !== excludeDedupeKey)
  );
}

export function managedProcessRunning(item: ManagedProcess): boolean {
  return isRunning(item);
}

export async function waitForManagedProcess(item: ManagedProcess, waitMs: number): Promise<boolean> {
  if (!isRunning(item)) return true;
  if (waitMs <= 0) return false;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    if (!isRunning(item)) return true;
  }
  return !isRunning(item);
}

export function snapshotManagedProcess(item: ManagedProcess, tailChars = 40_000) {
  refreshManagedProcess(item);
  item.stdoutChars = logSize(item.stdoutPath);
  item.stderrChars = logSize(item.stderrPath);
  return {
    id: item.id,
    pid: item.pid,
    command: item.command,
    cwd: item.cwd,
    started_at: item.startedAt,
    running: isRunning(item),
    exit_code: item.exitCode,
    signal: item.signal,
    stdout: readLogTail(item.stdoutPath, tailChars),
    stderr: readLogTail(item.stderrPath, tailChars),
    stability_class: item.stabilityClass,
    recovered: item.child === null,
    workspace_fingerprint: item.workspaceFingerprint,
  };
}

export function observeManagedProcess(item: ManagedProcess, tailChars = 40_000) {
  refreshManagedProcess(item);
  item.stdoutChars = logSize(item.stdoutPath);
  item.stderrChars = logSize(item.stderrPath);
  const outputChars = item.stdoutChars + item.stderrChars;
  const outputChanged = outputChars !== item.lastObservedOutputChars;
  item.pollCount++;

  if (outputChanged) {
    item.unchangedPollCount = 0;
  } else {
    item.unchangedPollCount++;
  }
  item.lastObservedOutputChars = outputChars;

  const running = isRunning(item);
  const schedule = [2_000, 5_000, 10_000, 15_000];
  const nextPollMs = running
    ? outputChanged
      ? schedule[0]
      : schedule[Math.min(Math.max(item.unchangedPollCount - 1, 0), schedule.length - 1)]
    : 0;

  return {
    ...snapshotManagedProcess(item, tailChars),
    output_changed: outputChanged,
    poll_count: item.pollCount,
    unchanged_poll_count: item.unchangedPollCount,
    next_poll_ms: nextPollMs,
    next_poll_at: nextPollMs > 0 ? new Date(Date.now() + nextPollMs).toISOString() : null,
  };
}

export function markManagedProcessResultCached(item: ManagedProcess): void {
  item.resultCached = true;
  persistMetadata(item);
}

export function stopManagedProcess(item: ManagedProcess, force = false): boolean {
  refreshManagedProcess(item);
  if (!isRunning(item) || item.pid === null) return false;
  try {
    if (process.platform === "win32") {
      const args = ["/PID", String(item.pid), "/T"];
      if (force) args.push("/F");
      const result = spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
      return result.status === 0;
    }
    try {
      process.kill(-item.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      process.kill(item.pid, force ? "SIGKILL" : "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

function removeManagedProcessData(item: ManagedProcess): void {
  try {
    fs.rmSync(item.stateDir, { recursive: true, force: true });
  } catch {}
}

export function clearFinishedManagedProcesses(): number {
  loadPersistedProcesses();
  let cleared = 0;
  for (const [id, item] of processes) {
    if (!isRunning(item)) {
      processes.delete(id);
      removeManagedProcessData(item);
      cleared++;
    }
  }
  return cleared;
}

export function pruneManagedProcesses(
  finishedRetentionMs = DEFAULT_FINISHED_RETENTION_MS,
  maxRecords = DEFAULT_MAX_RECORDS
): number {
  loadPersistedProcesses();
  const now = Date.now();
  let removed = 0;

  for (const [id, item] of processes) {
    if (!isRunning(item) && item.finishedAt !== null && now - item.finishedAt > finishedRetentionMs) {
      processes.delete(id);
      removeManagedProcessData(item);
      removed++;
    }
  }

  if (processes.size <= maxRecords) return removed;

  const removable = [...processes.values()]
    .filter((item) => !isRunning(item))
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

  while (processes.size > maxRecords && removable.length) {
    const item = removable.shift()!;
    if (processes.delete(item.id)) {
      removeManagedProcessData(item);
      removed++;
    }
  }

  return removed;
}
