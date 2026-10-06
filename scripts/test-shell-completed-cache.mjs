import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const tmpRoot = path.join(root, ".tool-test-tmp", "shell-completed-cache");
const repo = path.join(tmpRoot, "repo");
const stateDir = path.join(tmpRoot, "state");
process.env.MCP_SHELL_STATE_DIR = stateDir;
process.env.MCP_PROCESS_STATE_DIR = path.join(stateDir, "processes");
process.env.AUDIT_LOG_PATH = path.join(tmpRoot, "audit.log");
process.env.MCP_RUN_COMMAND_SYNC_MS = "8000";

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(repo, { recursive: true });

async function git(...args) {
  return execFileAsync("git", ["-C", repo, ...args], { windowsHide: true });
}

const packageJson = {
  private: true,
  scripts: {
    build: "node -e \"console.log('cache-build-ok')\"",
  },
};
await fs.writeFile(path.join(repo, "package.json"), JSON.stringify(packageJson, null, 2));
await git("init");
await git("config", "user.name", "Local Coder Test");
await git("config", "user.email", "local-coder-test@example.invalid");
await git("add", "package.json");
await git("commit", "-m", "init");

const { bootstrapShellSession } = await import("../dist/lib/persistent-shell.js");
const { registerShellTools } = await import("../dist/tools/shell.js");

await bootstrapShellSession(repo);
const handlers = new Map();
const server = {
  registerTool(name, _config, handler) {
    handlers.set(name, handler);
  },
};
registerShellTools(server, repo, 20);
await bootstrapShellSession(repo);

const runCommand = handlers.get("run_command");
assert.equal(typeof runCommand, "function");

const first = await runCommand({ command: "npm run build" });
assert.equal(first.structuredContent.ok, true);
assert.equal(first.structuredContent.data.exit_code, 0);
assert.equal(first.structuredContent.data.reused_completed, false);
assert.match(first.structuredContent.data.stdout, /cache-build-ok/);

const second = await runCommand({ command: "npm run build" });
assert.equal(second.structuredContent.ok, true);
assert.equal(second.structuredContent.data.reused_completed, true);
assert.match(second.structuredContent.data.stdout, /cache-build-ok/);
assert.ok(second.structuredContent.data.cached_at);

packageJson.description = "fingerprint mutation";
await fs.writeFile(path.join(repo, "package.json"), JSON.stringify(packageJson, null, 2));
const third = await runCommand({ command: "npm run build" });
assert.equal(third.structuredContent.ok, true);
assert.equal(third.structuredContent.data.reused_completed, false);

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log("shell completed-result cache integration: ok");