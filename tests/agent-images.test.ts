import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { validateImage } from '../src/services/agents/images';
import { createTestSymlink } from './helpers/symlink';

it('accepts matching image bytes and rejects mismatches and symlinks', async ({ skip }) => {
  const root = await mkdtemp(join(tmpdir(), 'loom-image-'));
  try {
    await writeFile(
      join(root, 'board.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    );
    await writeFile(join(root, 'fake.png'), 'not an image at all');
    if (!(await createTestSymlink('board.png', join(root, 'link.png'))))
      skip('This Windows host does not permit symbolic links.');
    await expect(validateImage(root, 'board.png')).resolves.toBeUndefined();
    await expect(validateImage(root, 'fake.png')).rejects.toThrow('contents');
    await expect(validateImage(root, 'link.png')).rejects.toThrow('symlinks');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
