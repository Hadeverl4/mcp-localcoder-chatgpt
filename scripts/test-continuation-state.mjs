import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const stateDir = path.join(process.cwd(), ".tool-test-tmp", "continuation-state");
process.env.MCP_SHELL_STATE_DIR = stateDir;
process.env.MCP_CONTINUATION_HISTORY_MAX = "4";

const {
  appendContinuationToolCall,
  compactContinuationArgs,
  loadContinuationToolCalls,
} = await import("../dist/lib/continuation-state.js");

const workspace = path.join(process.cwd(), ".tool-test-tmp", "continuation-workspace");
await fs.rm(stateDir, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });

const compact = compactContinuationArgs("apply_patch", {
  path: "C:\\repo\\src\\file.ts",
  dry_run: true,
  patch: "SECRET LARGE PATCH BODY",
  content: "SHOULD NOT BE STORED",
});
assert.equal(compact.path, "C:\\repo\\src\\file.ts");
assert.equal(compact.dry_run, true);
assert.equal("patch" in compact, false);
assert.equal("content" in compact, false);

for (const [tool, args, time] of [
  ["apply_patch", { path: "C:\\repo\\src\\file.ts", dry_run: true, patch: "omitted" }, "2026-01-01T00:00:00.000Z"],
  ["load_path_rules", { path: "C:\\repo\\src\\file.ts" }, "2026-01-01T00:00:01.000Z"],
  ["run_command", { command: "npm run build" }, "2026-01-01T00:00:02.000Z"],
  ["git_diff", { path: "C:\\repo", file: "src/file.ts" }, "2026-01-01T00:00:03.000Z"],
  ["read_text_file", { path: "C:\\repo\\src\\file.ts" }, "2026-01-01T00:00:04.000Z"],
]) {
  await appendContinuationToolCall(workspace, { tool, status: "ok", args, time });
}

const history = await loadContinuationToolCalls(workspace, 20);
assert.equal(history.length, 4);
assert.deepEqual(history.map((entry) => entry.tool), [
  "load_path_rules",
  "run_command",
  "git_diff",
  "read_text_file",
]);
assert.equal(history[1].args.command, "npm run build");
console.log("continuation-state: ok");