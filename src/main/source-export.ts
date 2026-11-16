import { syncDirectory } from '../domain/sync-directory';
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeSourceExport(
  destination: string,
  bytes: Uint8Array,
  project: { root: string; paths: string[] },
) {
  if (extname(destination).toLowerCase() !== '.zip')
    throw new Error('Choose a .zip filename for the source export.');
  const directory = await fs.realpath(dirname(destination));
  const target = join(directory, basename(destination));
  const projectRoot = await fs.realpath(project.root);
  const inside = relative(projectRoot, target);
  if (!inside.startsWith('..') && !isAbsolute(inside))
    throw new Error('Save the portable source archive outside the project folder.');
  if (project.paths.some((path) => resolve(project.root, path) === target))
    throw new Error(
      'The export destination is a project input. Choose a location outside the project.',
    );
  try {
    if ((await fs.lstat(target)).isSymbolicLink())
      throw new Error('Choose a regular file destination, not a symbolic link.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = join(directory, `.loom-source-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
    await syncDirectory(directory);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
