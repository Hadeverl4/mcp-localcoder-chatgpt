import { runPostEditHooks } from "./post-edit-hooks.js";

export async function enrichAfterEdit<T extends Record<string, unknown>>(
  data: T,
  filePaths: string[],
  dryRun?: boolean
): Promise<T> {
  if (dryRun || !filePaths.length) return data;
  const hooks = await runPostEditHooks(filePaths);
  if (!hooks) return data;
  return { ...data, ...hooks };
}