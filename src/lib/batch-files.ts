import fs from "fs/promises";
import path from "path";

export interface ReadManyRequest {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadManyFileResult {
  path: string;
  offset: number;
  requested_limit: number;
  lines: number;
  total_lines: number;
  truncated: boolean;
  content: string;
}

export async function readManyTextFiles(
  files: ReadManyRequest[],
  maxTotalLines = 1200
): Promise<{ files: ReadManyFileResult[]; total_lines: number; truncated: boolean }> {
  const loaded = await Promise.all(
    files.map(async (request) => ({
      request,
      lines: (await fs.readFile(request.path, "utf-8")).split("\n"),
    }))
  );

  let remaining = Math.max(1, maxTotalLines);
  let totalLines = 0;
  let truncated = false;
  const results: ReadManyFileResult[] = [];

  for (const { request, lines } of loaded) {
    const start = Math.max(0, (request.offset ?? 1) - 1);
    const requestedLimit = Math.max(1, request.limit ?? 200);
    const available = Math.max(0, lines.length - start);
    const wanted = Math.min(requestedLimit, available);
    const take = Math.min(wanted, remaining);
    const slice = lines.slice(start, start + take);
    const fileTruncated = take < wanted;

    if (fileTruncated) truncated = true;
    remaining = Math.max(0, remaining - take);
    totalLines += take;

    results.push({
      path: request.path,
      offset: start + 1,
      requested_limit: requestedLimit,
      lines: take,
      total_lines: lines.length,
      truncated: fileTruncated,
      content: slice
        .map((line, idx) => `${String(start + idx + 1).padStart(6, " ")}|${line}`)
        .join("\n"),
    });
  }

  return { files: results, total_lines: totalLines, truncated };
}

export interface InspectFilesOptions {
  pattern: string;
  path: string;
  glob?: string;
  caseInsensitive?: boolean;
  maxFiles?: number;
  contextAround?: number;
  maxLinesPerFile?: number;
}

export interface InspectFileResult {
  path: string;
  matches: number;
  lines: number;
  truncated: boolean;
  content: string;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length <= 1) return ranges;
  const merged: Array<[number, number]> = [];

  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1] + 1) {
      merged.push([start, end]);
    } else {
      last[1] = Math.max(last[1], end);
    }
  }

  return merged;
}

export async function inspectMatchingFiles(
  options: InspectFilesOptions
): Promise<{
  path: string;
  pattern: string;
  files: InspectFileResult[];
  file_count: number;
  matches_returned: number;
  truncated: boolean;
}> {
  const {
    pattern,
    path: searchRoot,
    glob = "*",
    caseInsensitive = false,
    maxFiles = 6,
    contextAround = 3,
    maxLinesPerFile = 80,
  } = options;

  const matcher = new RegExp(pattern, caseInsensitive ? "i" : undefined);
  const globMatcher = globToRegExp(glob);
  const results: InspectFileResult[] = [];
  let matchesReturned = 0;
  let truncated = false;

  async function inspectFile(filePath: string): Promise<void> {
    if (results.length >= maxFiles) {
      truncated = true;
      return;
    }

    let text: string;
    try {
      text = await fs.readFile(filePath, "utf-8");
    } catch {
      return;
    }

    const lines = text.split("\n");
    const matchIndexes: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (matcher.test(lines[i])) matchIndexes.push(i);
    }
    if (matchIndexes.length === 0) return;

    const matchSet = new Set(matchIndexes);
    const ranges = mergeRanges(
      matchIndexes.map((index) => [
        Math.max(0, index - contextAround),
        Math.min(lines.length - 1, index + contextAround),
      ])
    );

    const output: string[] = [];
    let emittedLines = 0;
    let fileTruncated = false;
    let previousEnd = -1;

    for (const [start, end] of ranges) {
      if (emittedLines >= maxLinesPerFile) {
        fileTruncated = true;
        break;
      }
      if (previousEnd >= 0 && start > previousEnd + 1) output.push("       |...");

      for (let i = start; i <= end; i++) {
        if (emittedLines >= maxLinesPerFile) {
          fileTruncated = true;
          break;
        }
        const marker = matchSet.has(i) ? ">" : " ";
        output.push(`${marker}${String(i + 1).padStart(6, " ")}|${lines[i]}`);
        emittedLines++;
      }
      previousEnd = end;
    }

    if (fileTruncated) truncated = true;
    matchesReturned += matchIndexes.length;
    results.push({
      path: filePath,
      matches: matchIndexes.length,
      lines: emittedLines,
      truncated: fileTruncated,
      content: output.join("\n"),
    });
  }

  async function walk(target: string): Promise<void> {
    if (results.length >= maxFiles) {
      truncated = true;
      return;
    }

    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return;
    }

    if (stat.isFile()) {
      if (globMatcher.test(path.basename(target))) await inspectFile(target);
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (globMatcher.test(entry.name)) {
        await inspectFile(fullPath);
      }
    }
  }

  await walk(searchRoot);
  return {
    path: searchRoot,
    pattern,
    files: results,
    file_count: results.length,
    matches_returned: matchesReturned,
    truncated,
  };
}