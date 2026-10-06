import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const tmpRoot = path.join(root, ".tool-test-tmp", "workspace-cache");
const repo = path.join(tmpRoot, "repo");
const stateDir = path.join(tmpRoot, "state");
process.env.MCP_SHELL_STATE_DIR = stateDir;

const { getWorkspaceFingerprint } = await import("../dist/lib/workspace-fingerprint.js");
const {
  isReusableCompletedCommand,
  loadCompletedResult,
  saveCompletedResult,
} = await import("../dist/lib/completed-result-cache.js");

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(repo, { recursive: true });

async function git(...args) {
  return execFileAsync("git", ["-C", repo, ...args], { windowsHide: true });
}

await git("init");
await git("config", "user.name", "Local Coder Test");
await git("config", "user.email", "local-coder-test@example.invalid");
await fs.writeFile(path.join(repo, "tracked.txt"), "alpha\n");
await git("add", "tracked.txt");
await git("commit", "-m", "init");

const clean = await getWorkspaceFingerprint(repo);
assert.ok(clean?.fingerprint);
await fs.writeFile(path.join(repo, "tracked.txt"), "beta\n");
const trackedChanged = await getWorkspaceFingerprint(repo);
assert.notEqual(trackedChanged?.fingerprint, clean?.fingerprint);

await fs.writeFile(path.join(repo, "tracked.txt"), "alpha\n");
const cleanAgain = await getWorkspaceFingerprint(repo);
assert.equal(cleanAgain?.fingerprint, clean?.fingerprint);

await fs.writeFile(path.join(repo, "scratch.txt"), "one");
const untracked = await getWorkspaceFingerprint(repo);
assert.notEqual(untracked?.fingerprint, clean?.fingerprint);
assert.equal(untracked?.untracked_count, 1);

assert.equal(isReusableCompletedCommand("npm run build"), true);
assert.equal(isReusableCompletedCommand("npm run build && echo unsafe"), false);
assert.equal(isReusableCompletedCommand("Remove-Item important.txt"), false);

const saved = await saveCompletedResult({
  command: "npm run build",
  cwd: repo,
  workspace_fingerprint: untracked.fingerprint,
  stdout: "build-ok",
  stderr: "",
});
assert.equal(saved?.exit_code, 0);
const hit = await loadCompletedResult("npm run build", repo, untracked.fingerprint);
assert.equal(hit?.stdout, "build-ok");
const miss = await loadCompletedResult("npm run build", repo, clean.fingerprint);
assert.equal(miss, null);

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log("workspace-fingerprint + completed-result-cache: ok");