import { symlink } from 'node:fs/promises';

/** Create a test symlink, returning false when the host does not permit symlinks. */
export async function createTestSymlink(
  target: string,
  path: string,
  type?: 'file' | 'dir' | 'junction',
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return false;
    throw error;
  }
}
