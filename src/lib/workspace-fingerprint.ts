import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 32 * 1024 * 1024;

export interface WorkspaceFingerprint {
  fingerprint: string;
  git_root: string;
  head: string;
  dirty: boolean;
  untracked_count: number;
}

function isInternalPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized === ".mcp-audit.log" ||
    normalized === ".mcp-state" ||
    normalized.startsWith(".mcp-state/") ||
    normalized === ".mcp-checkpoints" ||
    normalized.startsWith(".mcp-checkpoints/") ||
    normalized === ".tool-test-tmp" ||
    normalized.startsWith(".tool-test-tmp/")
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    maxBuffer: MAX_GIT_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

function filteredStatus(raw: string): string {
  const records = raw.split("\0").filter(Boolean);
  return records
    .filter((record) => {
      if (record.length < 4) return true;
      const candidate = record.slice(3);
      return !isInternalPath(candidate);
    })
    .join("\0");
}

export async function getWorkspaceFingerprint(cwd: string): Promise<WorkspaceFingerprint | null> {
  try {
    const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const head = (await git(gitRoot, ["rev-parse", "HEAD"])).trim();
    const [trackedDiff, rawStatus, untrackedRaw] = await Promise.all([
      git(gitRoot, ["diff", "--binary", "HEAD", "--"]),
      git(gitRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);

    const status = filteredStatus(rawStatus);
    const untracked = untrackedRaw
      .split("\0")
      .filter(Boolean)
      .filter((relativePath) => !isInternalPath(relativePath))
      .sort();

    const untrackedMetadata = await Promise.all(
      untracked.map(async (relativePath) => {
        try {
          const stat = await fs.stat(path.join(gitRoot, relativePath), { bigint: true });
          return [
            relativePath.replace(/\\/g, "/"),
            stat.size,
            stat.mtimeNs,
            stat.ctimeNs,
          ].join(":");
        } catch {
          return `${relativePath.replace(/\\/g, "/")}:missing`;
        }
      })
    );

    const digest = createHash("sha256")
      .update("workspace-fingerprint-v1\0")
      .update(head)
      .update("\0")
      .update(trackedDiff)
      .update("\0")
      .update(status)
      .update("\0")
      .update(untrackedMetadata.join("\0"))
      .digest("hex");

    return {
      fingerprint: `wf1-${digest.slice(0, 24)}`,
      git_root: gitRoot,
      head,
      dirty: status.length > 0 || trackedDiff.length > 0,
      untracked_count: untracked.length,
    };
  } catch {
    return null;
  }
}