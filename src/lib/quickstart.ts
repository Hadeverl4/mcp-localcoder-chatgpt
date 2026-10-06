export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Project memory + git state are already in MCP instructions from WORKSPACE_PATH.
2. Call project_context(path) only for a different repo than WORKSPACE_PATH.
3. Prefer inspect_files for search+context and read_many for known files to reduce MCP round-trips; use glob/grep/read_text_file when a narrower primitive is better.
4. Edit with apply_patch (preferred), multi_edit, or write_file for new files.
5. run_command auto-backgrounds long commands and prevents multiple heavy build/test jobs from running at once in the same cwd.
6. If backgrounded=true, poll process_output only after next_poll_ms; if interrupted, call shell_status once to recover resume_state instead of rerunning blindly.
7. When the user says "continue" after a stopped/interrupted coding turn, use shell_status + continuation_trail to resume from the next missing step.
8. Undo file edits with rewind (list → preview → restore). Shell/bash file changes are not tracked.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
- inspect_files / read_many: batch exploration to reduce network round-trips
- glob / grep / read_text_file: narrow exploration primitives
- apply_patch: single-file @@ hunks OR multi-file *** Begin Patch format
- create_directory / delete_directory / copy_file / move_file / delete_file
- run_command: auto-background + retry dedupe + one-heavy-job stability guard per cwd
- process_output: adaptive 2s → 5s → 10s → 15s poll backoff; follow next_poll_ms
- shell_status: persistent cwd plus resume_state and continuation_trail
- git_status / git_diff / git_add / git_commit / git_branch / git_restore / git_stash
- rewind: action=list|preview|restore|status — undo file edits via automatic checkpoints
- enabled upstream MCP tools are exposed directly as <server>__<tool> (for example chrome-devtools__list_pages, linear__get_user); prefer direct tools
- mcp_servers / mcp_tools / mcp_call — upstream diagnostics/fallback when a direct proxy is unavailable
- git_push / git_checkout / delete_directory: may be blocked by ChatGPT safety — use run_command fallback

## apply_patch — single file
@@
-old line
+new line
 context unchanged

## apply_patch — multi file
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

## Paths
Full machine access — use ANY absolute path (C:\\, D:\\, etc.). Relative paths resolve from default cwd.
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  _fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = [
    "# Codex Local Coder MCP",
    `Default project: ${workspaceRoot}`,
    "Full machine access: ON. Tag this connector in ChatGPT before every task.",
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Workspace roots: ${workspaceRoots.join("; ")}`,
    "agent_status — full tool cheat sheet + apply_patch format",
    "project_context(path) — load CLAUDE.md from another repo",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${footer}`;
  return `${header}\n\n${body}\n\n${footer}`;
}