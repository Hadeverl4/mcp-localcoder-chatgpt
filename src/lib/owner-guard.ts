import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type OwnerMode = "locked" | "readonly" | "armed";

export interface OwnerGuardState {
  version: 1;
  mode: OwnerMode;
  machine: string;
  user: string;
  sid: string;
  armed_at: string | null;
  expires_at: string | null;
  max_idle_minutes: number;
}

export interface OwnerGuardDecision {
  allowed: boolean;
  mode: OwnerMode;
  effective_mode: OwnerMode;
  reason: string;
  expires_at: string | null;
  idle_minutes: number | null;
  workstation_locked: boolean | null;
}

const READONLY_TOOLS = new Set([
  "read_text_file", "read_many", "glob", "grep", "inspect_files", "list_directory",
  "git_status", "git_diff", "agent_status", "project_context", "load_path_rules",
  "list_skills", "load_skill", "shell_status", "process_output", "mcp_servers", "mcp_tools",
]);

const LOCKED_TOOLS = new Set(["agent_status"]);

let cachedIdentity: { machine: string; user: string; sid: string } | null = null;
let cachedPresence: { at: number; idle_minutes: number | null; workstation_locked: boolean | null } | null = null;

function enabled(): boolean {
  const raw = (process.env.OWNER_GUARD_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function guardRoot(): string {
  const configured = process.env.OWNER_GUARD_STATE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (process.platform === "win32" && localAppData) {
    return path.join(localAppData, "ChatGPTLocalCoder", "OwnerGuard");
  }
  return path.join(os.homedir(), ".chatgpt-local-coder", "owner-guard");
}

export function getOwnerGuardStatePath(): string {
  return path.join(guardRoot(), "owner-lock.json");
}

function currentIdentity(): { machine: string; user: string; sid: string } {
  if (cachedIdentity) return cachedIdentity;
  const machine = (process.env.COMPUTERNAME || os.hostname()).trim();
  const user = (process.env.USERNAME || os.userInfo().username).trim();
  let sid = "";
  if (process.platform === "win32") {
    try {
      const raw = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
      }).trim();
      const match = raw.match(/"[^"]+","([^"]+)"/);
      sid = match?.[1]?.trim() || "";
    } catch {}
  }
  cachedIdentity = { machine, user, sid };
  return cachedIdentity;
}

function readState(): OwnerGuardState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getOwnerGuardStatePath(), "utf8")) as OwnerGuardState;
    if (parsed?.version !== 1) return null;
    if (!["locked", "readonly", "armed"].includes(parsed.mode)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setOwnerGuardMode(
  mode: OwnerMode,
  options?: { minutes?: number; idle_minutes?: number }
): OwnerGuardState {
  if (!["locked", "readonly", "armed"].includes(mode)) {
    throw new Error(`Invalid owner mode: ${mode}`);
  }

  const minutes = Math.trunc(options?.minutes ?? 60);
  const idleMinutes = Math.trunc(options?.idle_minutes ?? 10);
  if (!Number.isFinite(idleMinutes) || idleMinutes < 1 || idleMinutes > 240) {
    throw new Error("idle_minutes must be between 1 and 240");
  }
  if (mode === "armed" && (!Number.isFinite(minutes) || minutes < 1 || minutes > 480)) {
    throw new Error("minutes must be between 1 and 480");
  }

  const identity = currentIdentity();
  const now = new Date();
  const state: OwnerGuardState = {
    version: 1,
    mode,
    machine: identity.machine,
    user: identity.user,
    sid: identity.sid,
    armed_at: mode === "armed" ? now.toISOString() : null,
    expires_at: mode === "armed" ? new Date(now.getTime() + minutes * 60_000).toISOString() : null,
    max_idle_minutes: idleMinutes,
  };

  const statePath = getOwnerGuardStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, statePath);
  return state;
}

function getWindowsPresence(): { idle_minutes: number | null; workstation_locked: boolean | null } {
  if (process.platform !== "win32") return { idle_minutes: null, workstation_locked: null };
  const now = Date.now();
  if (cachedPresence && now - cachedPresence.at < 5000) return cachedPresence;

  let idle_minutes: number | null = null;
  let workstation_locked: boolean | null = null;
  try {
    const script = [
      "$locked = [bool](Get-Process LogonUI -ErrorAction SilentlyContinue);",
      "Add-Type @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class IdleProbe {",
      "  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
      "  [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);",
      "  [DllImport(\"kernel32.dll\")] public static extern ulong GetTickCount64();",
      "  public static double IdleMinutes() {",
      "    LASTINPUTINFO lii = new LASTINPUTINFO(); lii.cbSize = (uint)Marshal.SizeOf(lii);",
      "    if (!GetLastInputInfo(ref lii)) return -1;",
      "    return (GetTickCount64() - (ulong)lii.dwTime) / 60000.0;",
      "  }",
      "}",
      "'@;",
      "$idle=[IdleProbe]::IdleMinutes();",
      "Write-Output (([int]$locked).ToString() + '|' + $idle.ToString([Globalization.CultureInfo]::InvariantCulture));",
    ].join("\n");
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    }).trim();
    const [lockedRaw, idleRaw] = raw.split("|");
    workstation_locked = lockedRaw === "1";
    const parsedIdle = Number(idleRaw);
    idle_minutes = Number.isFinite(parsedIdle) && parsedIdle >= 0 ? parsedIdle : null;
  } catch {}

  cachedPresence = { at: now, idle_minutes, workstation_locked };
  return cachedPresence;
}

function allowedForMode(tool: string, mode: OwnerMode): boolean {
  if (mode === "armed") return true;
  if (mode === "readonly") return READONLY_TOOLS.has(tool);
  return LOCKED_TOOLS.has(tool);
}

export function evaluateOwnerGuard(tool: string): OwnerGuardDecision {
  if (!enabled()) {
    return {
      allowed: true,
      mode: "armed",
      effective_mode: "armed",
      reason: "owner guard disabled",
      expires_at: null,
      idle_minutes: null,
      workstation_locked: null,
    };
  }

  const state = readState();
  if (!state) {
    return {
      allowed: allowedForMode(tool, "locked"),
      mode: "locked",
      effective_mode: "locked",
      reason: "owner guard state missing; fail-closed",
      expires_at: null,
      idle_minutes: null,
      workstation_locked: null,
    };
  }

  const identity = currentIdentity();
  if (
    state.machine.toLowerCase() !== identity.machine.toLowerCase() ||
    state.user.toLowerCase() !== identity.user.toLowerCase() ||
    (state.sid && identity.sid && state.sid !== identity.sid)
  ) {
    return {
      allowed: allowedForMode(tool, "locked"),
      mode: state.mode,
      effective_mode: "locked",
      reason: "owner guard identity mismatch",
      expires_at: state.expires_at,
      idle_minutes: null,
      workstation_locked: null,
    };
  }

  let effective: OwnerMode = state.mode;
  let reason = `owner mode ${state.mode}`;
  const now = Date.now();

  if (state.mode === "armed") {
    const expires = state.expires_at ? Date.parse(state.expires_at) : NaN;
    if (!Number.isFinite(expires) || expires <= now) {
      effective = "readonly";
      reason = "owner arm expired";
    }
  }

  const presence = getWindowsPresence();
  if (state.mode === "armed" && presence.workstation_locked === true) {
    effective = "locked";
    reason = "Windows workstation is locked";
  } else if (
    state.mode === "armed" &&
    presence.idle_minutes !== null &&
    presence.idle_minutes > Math.max(1, state.max_idle_minutes)
  ) {
    effective = "readonly";
    reason = `Windows idle for ${presence.idle_minutes.toFixed(1)} min`;
  }

  return {
    allowed: allowedForMode(tool, effective),
    mode: state.mode,
    effective_mode: effective,
    reason,
    expires_at: state.expires_at,
    idle_minutes: presence.idle_minutes,
    workstation_locked: presence.workstation_locked,
  };
}

export function getOwnerGuardStatus(): OwnerGuardDecision & {
  enabled: boolean;
  state_path: string;
  machine: string;
  user: string;
  armed_at: string | null;
  max_idle_minutes: number | null;
} {
  const decision = evaluateOwnerGuard("agent_status");
  const identity = currentIdentity();
  const state = readState();
  return {
    ...decision,
    enabled: enabled(),
    state_path: getOwnerGuardStatePath(),
    machine: identity.machine,
    user: identity.user,
    armed_at: state?.armed_at ?? null,
    max_idle_minutes: state?.max_idle_minutes ?? null,
  };
}
