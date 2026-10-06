import { z } from "zod";

/**
 * Chuẩn output JSON cho mọi tool — ChatGPT dễ parse.
 *
 * Schema:
 * { ok, tool, summary, data }
 */
export interface ToolResultPayload<T = Record<string, unknown>> {
  ok: boolean;
  tool: string;
  summary: string;
  data: T;
  [key: string]: unknown;
}

/**
 * Shared structured-output schema advertised by every native Local Coder tool.
 * Individual tools intentionally keep `data` open because each tool has its own
 * payload shape, while the outer envelope is stable across the whole server.
 */
export const TOOL_RESULT_OUTPUT_SCHEMA = {
  ok: z.boolean().describe("Whether the tool operation succeeded"),
  tool: z.string().describe("Local Coder tool name"),
  summary: z.string().describe("Short human-readable result summary"),
  data: z.record(z.string(), z.unknown()).describe("Tool-specific structured result payload"),
};

export function toolResult<T extends object>(
  tool: string,
  data: T,
  options?: { ok?: boolean; summary?: string }
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const payload: ToolResultPayload = {
    ok: options?.ok ?? true,
    tool,
    summary: options?.summary ?? defaultSummary(tool, data as Record<string, unknown>),
    data: data as Record<string, unknown>,
  };

  const textMode = (process.env.TOOL_RESULT_TEXT_MODE || "summary").trim().toLowerCase();
  const textPayload =
    textMode === "full"
      ? payload
      : {
          ok: payload.ok,
          tool: payload.tool,
          summary: payload.summary,
        };

  return {
    content: [{ type: "text", text: JSON.stringify(textPayload) }],
    structuredContent: payload,
  };
}

export function toolError(tool: string, message: string, data?: Record<string, unknown>) {
  return toolResult(tool, { error: message, ...data }, { ok: false, summary: message });
}

function defaultSummary(tool: string, data: Record<string, unknown>): string {
  if (typeof data.path === "string") return `${tool}: ${data.path}`;
  if (typeof data.command === "string") return `${tool}: ${data.command}`;
  if (Array.isArray(data.files)) return `${tool}: ${data.files.length} file(s)`;
  if (Array.isArray(data.matches)) return `${tool}: ${data.matches.length} match(es)`;
  if (typeof data.exit_code === "number") return `${tool}: exit ${data.exit_code}`;
  return `${tool}: done`;
}