import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const stateDir = path.join(process.cwd(), ".tool-test-tmp", "batch-resume-state");
process.env.MCP_SHELL_STATE_DIR = stateDir;

const {
  createBatchId,
  loadBatchResumeState,
  saveProcessResumeState,
  saveBatchResumeState,
} = await import("../dist/lib/batch-resume-state.js");

const workspace = path.join(process.cwd(), ".tool-test-tmp", "batch-workspace");
await fs.mkdir(workspace, { recursive: true });
const batchId = createBatchId(workspace, "npm test", "fixed-seed");
assert.match(batchId, /^batch-[a-f0-9]{12}$/);

await saveBatchResumeState(workspace, {
  batch_id: batchId,
  cwd: workspace,
  command: "npm test",
  process_id: "proc-1",
  status: "running",
  started_at: "2026-01-01T00:00:00.000Z",
  exit_code: null,
  next_poll_ms: 5000,
  blocked_by_process_id: null,
});

const loaded = await loadBatchResumeState(workspace);
assert.equal(loaded?.batch_id, batchId);
assert.equal(loaded?.process_id, "proc-1");
assert.equal(loaded?.status, "running");
assert.equal(loaded?.next_poll_ms, 5000);

await saveBatchResumeState(workspace, {
  batch_id: "batch-deferred",
  cwd: workspace,
  command: "cargo test",
  process_id: null,
  status: "deferred",
  started_at: "2026-01-01T00:01:00.000Z",
  exit_code: null,
  next_poll_ms: 5000,
  blocked_by_process_id: "proc-blocker",
});

await saveProcessResumeState(workspace, {
  batch_id: "batch-proc-blocker",
  cwd: workspace,
  command: "npm test",
  process_id: "proc-blocker",
  status: "completed",
  started_at: "2026-01-01T00:00:30.000Z",
  exit_code: 0,
  next_poll_ms: 0,
  blocked_by_process_id: null,
});

const preservedDeferred = await loadBatchResumeState(workspace);
assert.equal(preservedDeferred?.batch_id, "batch-deferred");
assert.equal(preservedDeferred?.status, "deferred");
assert.equal(preservedDeferred?.blocked_by_process_id, "proc-blocker");

await saveProcessResumeState(workspace, {
  batch_id: "batch-next",
  cwd: workspace,
  command: "cargo test",
  process_id: "proc-next",
  status: "running",
  started_at: "2026-01-01T00:02:00.000Z",
  exit_code: null,
  next_poll_ms: 2000,
  blocked_by_process_id: null,
});

const nextProcess = await loadBatchResumeState(workspace);
assert.equal(nextProcess?.batch_id, "batch-next");
assert.equal(nextProcess?.process_id, "proc-next");
assert.equal(nextProcess?.status, "running");
console.log("batch-resume-state: ok");