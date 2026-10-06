import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cwd = process.cwd();
const processStateRoot = path.join(cwd, ".tool-test-tmp", "managed-process-state");
process.env.MCP_PROCESS_STATE_DIR = processStateRoot;
await fs.rm(processStateRoot, { recursive: true, force: true });

const {
  buildProcessDedupeKey,
  clearFinishedManagedProcesses,
  findRunningHeavyProcess,
  isLikelyHeavyCommand,
  managedProcessRunning,
  observeManagedProcess,
  pruneManagedProcesses,
  snapshotManagedProcess,
  startManagedProcess,
  waitForManagedProcess,
} = await import("../dist/lib/managed-process.js");

const delayCommand = process.platform === "win32"
  ? "Start-Sleep -Milliseconds 700; Write-Output managed-ok"
  : "sleep 0.7; echo managed-ok";

const key = buildProcessDedupeKey(delayCommand, cwd);
assert.equal(isLikelyHeavyCommand("cargo test --workspace"), true);
assert.equal(isLikelyHeavyCommand("npm run check"), true);
assert.equal(isLikelyHeavyCommand("Write-Output hello"), false);

const first = startManagedProcess(delayCommand, cwd, { dedupeKey: key, stabilityClass: "heavy" });
const second = startManagedProcess(delayCommand, cwd, { dedupeKey: key });

assert.equal(first.deduplicated, false);
assert.equal(second.deduplicated, true);
assert.equal(second.process.id, first.process.id);
assert.equal(managedProcessRunning(first.process), true);
assert.equal(findRunningHeavyProcess(cwd)?.id, first.process.id);

const poll1 = observeManagedProcess(first.process, 1000);
assert.equal(poll1.running, true);
assert.equal(poll1.next_poll_ms, 2000);
const poll2 = observeManagedProcess(first.process, 1000);
assert.equal(poll2.next_poll_ms, 5000);

const early = await waitForManagedProcess(first.process, 100);
assert.equal(early, false);
assert.equal(managedProcessRunning(first.process), true);

const completed = await waitForManagedProcess(first.process, 2_000);
assert.equal(completed, true);
const snapshot = snapshotManagedProcess(first.process);
assert.equal(snapshot.running, false);
assert.equal(snapshot.exit_code, 0);
assert.match(snapshot.stdout, /managed-ok/);
assert.equal(pruneManagedProcesses(60_000, 200), 0, "recent output should remain available for polling");

const third = startManagedProcess(delayCommand, cwd, { dedupeKey: key });
assert.equal(third.deduplicated, false, "finished process must not block an intentional rerun");
await waitForManagedProcess(third.process, 2_000);

const recoveryCommand = process.platform === "win32"
  ? "Start-Sleep -Milliseconds 1200; Write-Output durable-ok"
  : "sleep 1.2; echo durable-ok";
const durable = startManagedProcess(recoveryCommand, cwd, { dedupe: false });
const moduleUrl = pathToFileURL(path.join(cwd, "dist", "lib", "managed-process.js")).href;
const probe = `
  const m = await import(${JSON.stringify(moduleUrl)});
  const item = m.getManagedProcess(${JSON.stringify(durable.process.id)});
  if (!item) throw new Error("persisted process not found");
  const completed = await m.waitForManagedProcess(item, 5000);
  if (!completed) throw new Error("recovered process did not complete");
  const snapshot = m.snapshotManagedProcess(item);
  if (snapshot.exit_code !== 0 || !/durable-ok/.test(snapshot.stdout)) {
    throw new Error(JSON.stringify(snapshot));
  }
  console.log("recovered-process: ok");
`;
const recovered = await execFileAsync(process.execPath, ["--input-type=module", "-e", probe], {
  cwd,
  env: { ...process.env, MCP_PROCESS_STATE_DIR: processStateRoot },
  windowsHide: true,
});
assert.match(recovered.stdout, /recovered-process: ok/);
assert.equal(await waitForManagedProcess(durable.process, 2_000), true);

const parentDeathRoot = path.join(cwd, ".tool-test-tmp", "managed-process-parent-death");
await fs.rm(parentDeathRoot, { recursive: true, force: true });
const parentCommand = process.platform === "win32"
  ? "Start-Sleep -Milliseconds 3000; Write-Output parent-death-ok"
  : "sleep 3; echo parent-death-ok";
const parentProbe = `
  const m = await import(${JSON.stringify(moduleUrl)});
  const started = m.startManagedProcess(${JSON.stringify(parentCommand)}, process.cwd(), { dedupe: false });
  console.log(started.process.id);
`;
const parentStartedAt = Date.now();
const parent = await execFileAsync(process.execPath, ["--input-type=module", "-e", parentProbe], {
  cwd,
  env: { ...process.env, MCP_PROCESS_STATE_DIR: parentDeathRoot },
  windowsHide: true,
});
const parentElapsedMs = Date.now() - parentStartedAt;
assert.ok(parentElapsedMs < 2_000, `launcher parent stayed alive too long: ${parentElapsedMs}ms`);
const parentJobId = parent.stdout.trim().split(/\r?\n/).at(-1);
assert.ok(parentJobId, "parent-death probe did not return a job id");

const parentRecoveryProbe = `
  const m = await import(${JSON.stringify(moduleUrl)});
  const item = m.getManagedProcess(${JSON.stringify(parentJobId)});
  if (!item) throw new Error("parent-death persisted process not found");
  const completed = await m.waitForManagedProcess(item, 6000);
  if (!completed) throw new Error("parent-death job did not complete");
  const snapshot = m.snapshotManagedProcess(item);
  if (snapshot.exit_code !== 0 || !/parent-death-ok/.test(snapshot.stdout)) {
    throw new Error(JSON.stringify(snapshot));
  }
  console.log("parent-death-recovery: ok");
`;
const parentRecovery = await execFileAsync(
  process.execPath,
  ["--input-type=module", "-e", parentRecoveryProbe],
  {
    cwd,
    env: { ...process.env, MCP_PROCESS_STATE_DIR: parentDeathRoot },
    windowsHide: true,
  }
);
assert.match(parentRecovery.stdout, /parent-death-recovery: ok/);
await fs.rm(parentDeathRoot, { recursive: true, force: true });

const missingCwd = path.join(cwd, ".tool-test-tmp", "missing-managed-process-cwd");
const spawnFailure = startManagedProcess("echo should-not-run", missingCwd, { dedupe: false });
assert.equal(await waitForManagedProcess(spawnFailure.process, 1_000), true);
const failedSnapshot = snapshotManagedProcess(spawnFailure.process);
assert.equal(failedSnapshot.running, false, "spawn failure must not remain stuck as running");
assert.equal(failedSnapshot.exit_code, -1);
assert.match(failedSnapshot.stderr, /ENOENT|no such file|cannot find/i);

assert.ok(clearFinishedManagedProcesses() >= 2);
await fs.rm(processStateRoot, { recursive: true, force: true });
console.log("managed-process: ok");