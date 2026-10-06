/**
 * Verify fast/slim tool profiles expose expected tools only.
 */
import {
  FAST_CHATGPT_TOOLS,
  SLIM_CHATGPT_TOOLS,
  shouldExposeTool,
} from "../dist/lib/tool-profile.js";

const ALL_KNOWN = [
  "read_text_file", "write_file", "apply_patch", "glob", "grep", "run_command",
  "git_status", "mcp_call", "delete_directory", "read_file_base64",
];

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  if (SLIM_CHATGPT_TOOLS.size < 18) throw new Error(`slim set too small: ${SLIM_CHATGPT_TOOLS.size}`);
  ok(`slim profile has ${SLIM_CHATGPT_TOOLS.size} tools`);

  if (FAST_CHATGPT_TOOLS.size !== 17) throw new Error(`fast set changed unexpectedly: ${FAST_CHATGPT_TOOLS.size}`);
  ok(`fast profile has ${FAST_CHATGPT_TOOLS.size} tools`);

  for (const t of ["read_text_file", "read_many", "inspect_files", "apply_patch", "grep", "run_command", "agent_status", "rewind"]) {
    if (!shouldExposeTool(t, "fast")) throw new Error(`${t} missing from fast`);
  }
  ok("core tools exposed in fast");

  for (const t of ["edit_file", "multi_edit", "list_directory", "git_commit", "mcp_servers"]) {
    if (shouldExposeTool(t, "fast")) throw new Error(`${t} should be hidden in fast`);
  }
  ok("redundant tools hidden in fast");

  for (const t of ["apply_patch", "glob", "read_many", "inspect_files", "remember", "load_path_rules"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("core tools exposed in slim");

  if (shouldExposeTool("mcp_call", "slim")) throw new Error("mcp_call should be hidden in slim");
  if (shouldExposeTool("delete_directory", "slim")) throw new Error("delete_directory hidden");
  ok("heavy tools hidden in slim");

  if (!shouldExposeTool("mcp_call", "full")) throw new Error("full should expose all");
  ok("full profile exposes all");
} catch (e) {
  fail("tool profile", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);