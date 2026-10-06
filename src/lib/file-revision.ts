import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export async function getFileRevision(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath, { bigint: true });
  const source = [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
  return `r1-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}