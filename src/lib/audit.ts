import fs from "fs/promises";
import path from "path";
import { appendActivity } from "./activity-log.js";

export type AuditStatus = "ok" | "error" | "blocked" | "dry-run";

export interface AuditEvent {
  tool: string;
  action: string;
  target?: string;
  status?: AuditStatus;
  details?: Record<string, unknown>;
}

const auditPath = process.env.AUDIT_LOG_PATH || path.resolve(process.cwd(), ".mcp-audit.log");
let auditHandlePromise: ReturnType<typeof fs.open> | null = null;

async function getAuditHandle() {
  if (!auditHandlePromise) {
    auditHandlePromise = (async () => {
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      return fs.open(auditPath, "a");
    })();
  }

  try {
    return await auditHandlePromise;
  } catch (error) {
    auditHandlePromise = null;
    throw error;
  }
}

export async function audit(event: AuditEvent): Promise<void> {
  const record = {
    time: new Date().toISOString(),
    pid: process.pid,
    ...event,
  };

  try {
    const handle = await getAuditHandle();
    await handle.appendFile(JSON.stringify(record) + "\n", "utf-8");
  } catch {
    auditHandlePromise = null;
    // Audit must never break the requested tool call.
  }

  try {
    appendActivity({
      kind: "tool",
      tool: event.tool,
      action: event.action,
      target: event.target,
      status: event.status ?? "ok",
      summary: event.target || (event.details ? JSON.stringify(event.details).slice(0, 120) : undefined),
      details: event.details,
    });
  } catch {}
}

export function getAuditPath(): string {
  return auditPath;
}
