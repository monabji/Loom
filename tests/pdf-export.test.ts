import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePdfExport } from '../src/main/pdf-export';
import { createTestSymlink } from './helpers/symlink';
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'loom-pdf-export-'));
  await fs.mkdir(join(directory, 'project'));
  await fs.writeFile(join(directory, 'project/main.tex'), 'manuscript');
  await fs.writeFile(join(directory, 'project/figure.pdf'), '%PDF-asset');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
const pdf = Buffer.from('%PDF-1.7\nexport');
const project = () => ({ root: join(directory, 'project'), paths: ['main.tex', 'figure.pdf'] });
it('exports atomically while protecting manuscript inputs and linked destinations', async () => {
  await expect(writePdfExport(join(directory, 'project/main.tex'), pdf, project())).rejects.toThrow(
    '.pdf',
  );
  await expect(
    writePdfExport(join(directory, 'project/figure.pdf'), pdf, project()),
  ).rejects.toThrow('project input');
  if (await createTestSymlink(join(directory, 'project/main.tex'), join(directory, 'linked.pdf')))
    await expect(writePdfExport(join(directory, 'linked.pdf'), pdf, project())).rejects.toThrow(
      'symbolic link',
    );
  expect(
    await createTestSymlink(
      join(directory, 'project'),
      join(directory, 'linked-directory'),
      process.platform === 'win32' ? 'junction' : 'dir',
    ),
  ).toBe(true);
  await expect(
    writePdfExport(join(directory, 'linked-directory/figure.pdf'), pdf, project()),
  ).rejects.toThrow('project input');
  await fs.link(join(directory, 'project/main.tex'), join(directory, 'hard-linked.pdf'));
  await writePdfExport(join(directory, 'hard-linked.pdf'), pdf, project());
  expect(await fs.readFile(join(directory, 'project/main.tex'), 'utf8')).toBe('manuscript');
  expect(await fs.readFile(join(directory, 'project/figure.pdf'), 'utf8')).toBe('%PDF-asset');
  expect(await fs.readFile(join(directory, 'hard-linked.pdf'))).toEqual(pdf);
});
it('an interrupted replacement retains the existing destination and removes disposable bytes', async () => {
  const destination = join(directory, 'existing.pdf');
  await fs.writeFile(destination, 'previous PDF');
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Interrupted replacement'));
  await expect(writePdfExport(destination, pdf, project())).rejects.toThrow('Interrupted');
  expect(await fs.readFile(destination, 'utf8')).toBe('previous PDF');
  expect((await fs.readdir(directory)).some((name) => name.startsWith('.loom-pdf-'))).toBe(false);
});
