import fs from "fs";
import path from "path";

export type ToolProfileName = "full" | "slim" | "fast";

export const LOCAL_TOOL_CATALOG = [
  "read_text_file", "read_many", "write_file", "edit_file", "multi_edit", "apply_patch", "glob", "grep", "inspect_files", "list_directory",
  "run_command", "shell_status", "shell_reset", "start_process", "process_output", "node_repl", "ponytail_turn",
  "git_status", "git_diff", "git_add", "git_commit", "git_restore", "agent_status", "project_context",
  "remember", "load_path_rules", "list_skills", "load_skill", "rewind", "mcp_servers", "mcp_tools", "mcp_call",
];

/** Latency-focused profile for everyday ChatGPT coding/debugging hot paths. */
export const FAST_CHATGPT_TOOLS = new Set([
  "read_text_file",
  "read_many",
  "write_file",
  "apply_patch",
  "glob",
  "grep",
  "inspect_files",
  "run_command",
  "shell_status",
  "start_process",
  "process_output",
  "git_status",
  "git_diff",
  "agent_status",
  "project_context",
  "load_path_rules",
  "rewind",
]);

interface LocalToolOverrides {
  enabled?: string[];
  disabled?: string[];
}

const overridesPath = () => path.resolve(process.cwd(), "profiles", "tool-overrides.json");

export function getLocalToolOverrides(): LocalToolOverrides {
  try {
    return JSON.parse(fs.readFileSync(overridesPath(), "utf-8")) as LocalToolOverrides;
  } catch {
    return {};
  }
}

export function saveLocalToolOverrides(next: LocalToolOverrides): void {
  fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
  fs.writeFileSync(overridesPath(), JSON.stringify(next, null, 2));
}

/** Core tools for ChatGPT web — smaller tools/list payload, fewer discovery errors. */
export const SLIM_CHATGPT_TOOLS = new Set([
  "read_text_file",
  "read_many",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "inspect_files",
  "list_directory",
  "run_command",
  "shell_status",
  "start_process",
  "process_output",
  "git_status",
  "git_diff",
  "git_add",
  "git_commit",
  "git_restore",
  "agent_status",
  "project_context",
  "remember",
  "load_path_rules",
  "list_skills",
  "load_skill",
  "node_repl",
  "ponytail_turn",
  "rewind",
  "mcp_servers",
]);

export function getChatGptToolProfile(): ToolProfileName {
  const raw = (process.env.CHATGPT_TOOL_PROFILE || "slim").trim().toLowerCase();
  if (raw === "fast") return "fast";
  return raw === "full" ? "full" : "slim";
}

export function shouldExposeTool(name: string, profile: ToolProfileName = getChatGptToolProfile()): boolean {
  const overrides = getLocalToolOverrides();
  if ((overrides.disabled ?? []).includes(name)) return false;
  if (profile === "full") return true;
  if (profile === "fast") return FAST_CHATGPT_TOOLS.has(name) || (overrides.enabled ?? []).includes(name);
  return SLIM_CHATGPT_TOOLS.has(name) || (overrides.enabled ?? []).includes(name);
}
