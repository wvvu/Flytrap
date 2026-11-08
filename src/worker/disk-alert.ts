import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AppLog } from "../log.js";

/** Recursive size of a directory tree in bytes. Unreadable or vanished entries count as 0. */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSizeBytes(full);
      else if (entry.isFile()) total += (await stat(full)).size;
    } catch {
      // A file that vanished mid-scan, or one we cannot read, counts as 0.
    }
  }
  return total;
}

export interface DiskAlertInput {
  dataDir: string;
  limitBytes: number;
  log: AppLog;
}

/** Measure the mail data dir once. Warns (never deletes) when it is over the limit. */
export async function checkDiskAlert(input: DiskAlertInput): Promise<{ bytes: number; over: boolean }> {
  const bytes = await dirSizeBytes(input.dataDir);
  const over = input.limitBytes > 0 && bytes > input.limitBytes;
  if (over) {
    input.log.warn(
      { bytes, limitBytes: input.limitBytes, dataDir: input.dataDir },
      "mail data dir over the disk alert limit",
    );
  }
  return { bytes, over };
}
