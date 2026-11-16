import { open } from 'node:fs/promises';

/** Flush directory entries where Node can open a directory for fsync. */
export async function syncDirectory(path: string): Promise<void> {
  // Windows Node cannot open a directory this way. Callers still flush the file
  // before publishing it via rename or link.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
