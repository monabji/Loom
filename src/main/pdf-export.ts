import { syncDirectory } from '../domain/sync-directory';
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Native-picker destination only. Atomic replacement never writes through a link. */
export async function writePdfExport(
  destination: string,
  bytes: Uint8Array,
  project: { root: string; paths: string[] },
): Promise<void> {
  if (extname(destination).toLowerCase() !== '.pdf')
    throw new Error('Choose a .pdf filename for the export.');
  const directory = await fs.realpath(dirname(destination));
  const target = join(directory, basename(destination));
  if (project.paths.some((path) => relative(resolve(project.root, path), target) === ''))
    throw new Error(
      'This destination is a project input. Choose a new PDF filename or a location outside the project.',
    );
  try {
    if ((await fs.lstat(target)).isSymbolicLink())
      throw new Error('Choose a regular PDF destination, not a symbolic link.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = join(directory, `.loom-pdf-${randomUUID()}`);
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Replace the directory entry rather than truncating the old inode. An external
    // hard link to manuscript source is detached, leaving the source bytes intact.
    await fs.rename(temp, target);
    await syncDirectory(directory);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
