import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';
import { zipSync, strToU8 } from 'fflate';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';
import { reconcile } from '../src/services/project/reconcile';
import { projectCommandSchema } from '../src/contracts/project';
let dir: string, root: string, store: MetadataStore, service: ProjectService;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loom-project-'));
  root = join(dir, '论文');
  await mkdir(root);
  await writeFile(join(root, 'main.tex'), 'alpha\nbeta\ngamma\n');
  store = new MetadataStore(join(dir, 'data'));
  service = new ProjectService(store);
  await service.open(root);
  await service.command({ type: 'load', fileId: service.snapshot().files[0].id });
});
afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await rm(dir, { recursive: true, force: true });
});
async function edit(text: string) {
  const f = service.snapshot().files[0],
    doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(f.update));
  doc.getText('source').delete(0, doc.getText('source').length);
  doc.getText('source').insert(0, text);
  return {
    type: 'sync' as const,
    fileId: f.id,
    update: Array.from(Y.encodeStateAsUpdate(doc)),
    baseline: f.baseline,
    text,
  };
}
it('observes unchanged files without reading content or replacing the search index', async () => {
  const reads = vi.spyOn(fs, 'readFile');
  const index = vi.spyOn(store, 'index');
  const before = store.db.prepare('SELECT total_changes() AS n').get();
  for (let i = 0; i < 3; i++) await service.command({ type: 'refresh' });
  expect(reads).not.toHaveBeenCalled();
  expect(index).not.toHaveBeenCalled();
  expect(store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});
it('indexes a 1,002-file project on open and preserves initial search through no-op observations', async () => {
  const source = Array.from({ length: 100 }, (_, i) => `% synthetic line ${i}\n`).join('');
  await mkdir(join(root, 'sections'));
  // Bound setup concurrency; this is a synthetic service regression, not a
  // packaged idle-CPU benchmark or a one-second wall-clock observer simulation.
  for (let start = 0; start < 1000; start += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, 1000 - start) }, (_, offset) =>
        writeFile(join(root, 'sections', `${start + offset}.tex`), source),
      ),
    );
  }
  await writeFile(
    join(root, 'sections', 'large-file.tex'),
    Array.from({ length: 10_000 }, (_, i) => `% large-file line ${i + 1}\n`).join(''),
  );
  // A fresh service/database must index every file on open, before any observer
  // or explicit refresh and without loading the large document into a renderer.
  store.close();
  store = new MetadataStore(join(dir, 'fresh-data'));
  service = new ProjectService(store);
  await service.open(root);
  expect(service.snapshot().files).toHaveLength(1002);
  const large = service.snapshot().files.find((file) => file.path === 'sections/large-file.tex')!;
  expect(large.loaded).toBe(false);
  expect(store.hits(root, 'large-file line 9999')).toMatchObject([
    { fileId: large.id, path: large.path, line: 9999 },
  ]);
  expect(
    (await service.command({ type: 'search', query: 'large-file line 9999' }))?.matches,
  ).toEqual([large.id]);
  const reads = vi.spyOn(fs, 'readFile');
  const index = vi.spyOn(store, 'index');
  const revision = store.changeCount();
  for (let i = 0; i < 3; i++) await service.command({ type: 'refresh' });
  expect(reads).not.toHaveBeenCalled();
  expect(index).not.toHaveBeenCalled();
  expect(store.changeCount()).toBe(revision);
  expect(
    (await service.command({ type: 'search', query: 'large-file line 9999' }))?.matches,
  ).toEqual([large.id]);
});
it('invalidates observation reads for same-sized writes, atomic replacements and unchanged-content touches', async () => {
  const path = join(root, 'main.tex');
  const original = await fs.stat(path);
  await writeFile(path, 'ALPHA\nbeta\ngamma\n');
  await fs.utimes(path, original.atime, original.mtime);
  const reads = vi.spyOn(fs, 'readFile');
  await service.command({ type: 'refresh' });
  expect(reads).toHaveBeenCalledTimes(1);
  expect(service.snapshot().files[0].text).toBe('ALPHA\nbeta\ngamma\n');
  reads.mockClear();
  await service.command({ type: 'refresh' });
  expect(reads).not.toHaveBeenCalled();
  const id = service.snapshot().files[0].id;
  await writeFile(join(root, '.loom-save-replacement'), 'replacement');
  await rename(join(root, '.loom-save-replacement'), path);
  await service.command({ type: 'refresh' });
  expect(service.snapshot().files[0]).toMatchObject({ id, text: 'replacement', conflict: false });
  reads.mockClear();
  const before = store.changeCount();
  await fs.utimes(path, new Date(), new Date(Date.now() + 1000));
  await service.command({ type: 'refresh' });
  expect(reads).toHaveBeenCalledTimes(1);
  expect(store.changeCount()).toBe(before);
});
it('observes creates, renames, deletes and binary changes without rereading unrelated files', async () => {
  const reads = vi.spyOn(fs, 'readFile');
  await writeFile(join(root, 'new.tex'), 'new searchable source');
  await service.command({ type: 'refresh' });
  expect(reads.mock.calls.map(([path]) => path)).toEqual([join(root, 'new.tex')]);
  const id = service.snapshot().files.find((file) => file.path === 'new.tex')!.id;
  await rename(join(root, 'new.tex'), join(root, 'renamed.tex'));
  await service.command({ type: 'refresh' });
  expect(service.snapshot().files.find((file) => file.id === id)?.path).toBe('renamed.tex');
  expect(store.hits(root, 'searchable')[0].path).toBe('renamed.tex');
  await rm(join(root, 'renamed.tex'));
  await service.command({ type: 'refresh' });
  expect(service.snapshot().files.find((file) => file.id === id)).toMatchObject({
    conflict: true,
    diskKind: 'missing',
  });
  await writeFile(join(root, 'main.tex'), Buffer.from([0, 255]));
  await service.command({ type: 'refresh' });
  expect(service.snapshot().files[0]).toMatchObject({ conflict: true, diskKind: 'binary' });
  const revision = service.snapshot().files[0].diskRevision;
  await writeFile(join(root, 'main.tex'), Buffer.from([0, 254]));
  await service.command({ type: 'refresh' });
  expect(service.snapshot().files[0].diskRevision).not.toBe(revision);
});
it('retains dirty recovery and updates its index when disk content is cached', async () => {
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('interrupted'));
  await expect(service.command(await edit('human recovery'))).rejects.toThrow('interrupted');
  const reads = vi.spyOn(fs, 'readFile');
  // A plain observation reconciles but does not attempt to save; the same disk
  // bytes must not hide a changed live document from indexing or recovery.
  await service.refresh(true);
  expect(reads).not.toHaveBeenCalled();
  expect(store.search(root, 'human recovery')).toEqual([service.snapshot().files[0].id]);
  expect(service.snapshot().files[0]).toMatchObject({ text: 'human recovery', saved: false });
  await writeFile(join(root, 'main.tex'), 'external replacement');
  await service.refresh(true);
  expect(service.snapshot().files[0]).toMatchObject({
    text: 'human recovery',
    baseline: 'alpha\nbeta\ngamma\n',
    disk: 'external replacement',
    conflict: true,
  });
  await service.open(root);
  await service.command({ type: 'load', fileId: service.snapshot().files[0].id });
  expect(service.snapshot().files[0]).toMatchObject({ text: 'human recovery', conflict: true });
});
it('does not cache a read that overlaps an external write', async () => {
  const actual = fs.readFile.bind(fs);
  await writeFile(join(root, 'main.tex'), 'first external');
  const reads = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
    const bytes = await actual(...args);
    await writeFile(join(root, 'main.tex'), 'newer external');
    return bytes;
  });
  await service.refresh(true);
  await service.refresh(true);
  expect(reads).toHaveBeenCalledTimes(2);
  expect(service.snapshot().files[0].text).toBe('newer external');
});
it('keeps pre-operation refreshes authoritative and isolates caches across project switches', async () => {
  const reads = vi.spyOn(fs, 'readFile');
  await service.command({ type: 'search', query: 'alpha' });
  expect(reads).toHaveBeenCalledWith(join(root, 'main.tex'));
  const other = join(dir, 'other');
  await mkdir(other);
  await writeFile(join(other, 'main.tex'), 'other paper');
  await service.open(other);
  reads.mockClear();
  await service.command({ type: 'refresh' });
  expect(reads).not.toHaveBeenCalled();
  expect(store.search(other, 'other paper')).toHaveLength(1);
  await service.open(root);
  expect(store.search(root, 'alpha')).toHaveLength(1);
  await service.command({ type: 'load', fileId: service.snapshot().files[0].id });
  expect(service.snapshot().files[0].baseline).toBe('alpha\nbeta\ngamma\n');
});
it('enforces aggregate limits even when earlier files are cached and retries failed scans', async () => {
  for (let i = 0; i < 4; i++)
    await writeFile(join(root, `asset-${i}.bin`), Buffer.alloc(8 * 1024 * 1024));
  await expect(service.refresh(true)).rejects.toThrow('32 MiB');
  await rm(join(root, 'asset-3.bin'));
  await service.refresh(true);
  const reads = vi.spyOn(fs, 'readFile');
  await service.refresh(true);
  expect(reads).not.toHaveBeenCalled();
  await writeFile(join(root, 'asset-3.bin'), Buffer.alloc(8 * 1024 * 1024));
  await expect(service.refresh(true)).rejects.toThrow('32 MiB');
});
describe('ordinary projects and persistence', () => {
  it('imports a pasted image exclusively and preserves existing files on invalid or repeated input', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const command = {
      type: 'import-image' as const,
      projectId: service.snapshot().id,
      path: 'paste.png',
      data: bytes.toString('base64'),
    };
    await service.command(command);
    expect(await readFile(join(root, 'paste.png'))).toEqual(bytes);
    const preview = await service.command({
      type: 'preview-image',
      projectId: command.projectId,
      path: command.path,
    });
    expect(preview?.imagePreview).toEqual({
      path: 'paste.png',
      mime: 'image/png',
      data: bytes.toString('base64'),
    });
    await expect(
      service.command({ type: 'preview-image', projectId: 'wrong', path: command.path }),
    ).rejects.toThrow('paper changed');
    await expect(service.command(command)).rejects.toThrow();
    await expect(
      service.command({
        ...command,
        path: 'other.png',
        data: Buffer.from('wrong image').toString('base64'),
      }),
    ).rejects.toThrow('Choose a PNG');
    await expect(service.command({ ...command, projectId: 'wrong' })).rejects.toThrow(
      'paper changed',
    );
    expect(await readFile(join(root, 'paste.png'))).toEqual(bytes);
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });
  it('does not publish a partial pasted image when the final link fails', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    vi.spyOn(fs, 'link').mockRejectedValueOnce(new Error('simulated interruption'));
    await expect(
      service.command({
        type: 'import-image',
        projectId: service.snapshot().id,
        path: 'paste.png',
        data: bytes.toString('base64'),
      }),
    ).rejects.toThrow('simulated interruption');
    await expect(readFile(join(root, 'paste.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });
  it('copies a selected external image without overwriting the source or project assets', async () => {
    const bytes = await readFile('tests/fixtures/whiteboard-equation.png');
    const source = join(dir, 'outside.png');
    await writeFile(source, bytes);
    await writeFile(join(root, 'existing.png'), bytes);
    const projectId = service.snapshot().id;
    await service.importExternalImage(projectId, source, 'imported.png');
    expect(await readFile(join(root, 'imported.png'))).toEqual(bytes);
    expect(await readFile(source)).toEqual(bytes);
    await expect(service.importExternalImage(projectId, source, 'existing.png')).rejects.toThrow();
    await expect(service.importExternalImage('wrong', source, 'other.png')).rejects.toThrow(
      'paper changed',
    );
    await writeFile(source, 'not an image');
    await expect(service.importExternalImage(projectId, source, 'other.png')).rejects.toThrow(
      'Choose a PNG',
    );
    expect(await readFile(join(root, 'existing.png'))).toEqual(bytes);
  });
  it('accepts a large external rewrite without a conflict when the author has no unsaved edits', async () => {
    const baseline = Array.from({ length: 7000 }, (_, i) => `original ${i}\n`).join('');
    const external = Array.from({ length: 7000 }, (_, i) => `replacement ${i}\n`).join('');
    await writeFile(join(root, 'large.tex'), baseline);
    await service.refresh();
    const id = service.snapshot().files.find((f) => f.path === 'large.tex')!.id;
    await service.command({ type: 'load', fileId: id });
    await writeFile(join(root, 'large.tex'), external);
    await service.refresh();
    const file = service.snapshot().files.find((f) => f.id === id)!;
    expect(file.conflict).toBe(false);
    expect(file.text === external && file.baseline === external && file.saved).toBe(true);
  });
  it('retains concurrent author text when complex external changes exceed the merge budget', async () => {
    const baseline = Array.from({ length: 7000 }, (_, i) => `original ${i}\n`).join('');
    const external = Array.from({ length: 7000 }, (_, i) => `replacement ${i}\n`).join('');
    await writeFile(join(root, 'large.tex'), baseline);
    await service.refresh();
    const id = service.snapshot().files.find((f) => f.path === 'large.tex')!.id;
    await service.command({ type: 'load', fileId: id });
    const f = service.snapshot().files.find((file) => file.id === id)!;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(f.update));
    doc.getText('source').insert(0, 'author text\n');
    await writeFile(join(root, 'large.tex'), external);
    await service.command({
      type: 'sync',
      fileId: id,
      update: Array.from(Y.encodeStateAsUpdate(doc)),
      baseline: f.baseline,
      text: 'author text\n' + baseline,
    });
    expect(service.snapshot().files.find((file) => file.id === id)).toMatchObject({
      conflict: true,
      text: 'author text\n' + baseline,
      baseline,
      disk: external,
    });
    expect(await readFile(join(root, 'large.tex'), 'utf8')).toBe(external);
  });
  it('changes build freshness for unresolved disk overlaps and missing files without discarding recovery text', async () => {
    const command = await edit('local\nbeta\ngamma\n');
    await writeFile(join(root, 'main.tex'), 'external\nbeta\ngamma\n');
    await service.command(command);
    const before = service.snapshot();
    expect(before.files[0].conflict).toBe(true);
    await writeFile(join(root, 'main.tex'), 'newer external\nbeta\ngamma\n');
    await service.refresh();
    expect(service.snapshot().sourceRevision).not.toBe(before.sourceRevision);
    expect(service.snapshot().files[0].text).toBe(before.files[0].text);
    const overlap = service.snapshot().sourceRevision;
    await rm(join(root, 'main.tex'));
    await service.refresh();
    expect(service.snapshot().sourceRevision).not.toBe(overlap);
    expect(service.snapshot().files[0].text).toBe(before.files[0].text);
  });
  it('native file creation validates identity, containment, symlinks and existing files', async () => {
    const projectId = service.snapshot().id;
    await expect(service.createFile(join(dir, 'outside.tex'), projectId)).rejects.toThrow(
      'inside the open project',
    );
    await expect(service.createFile(join(root, 'main.tex'), 'stale-project')).rejects.toThrow(
      'project changed',
    );
    await expect(service.createFile(join(root, 'main.tex'), projectId)).rejects.toThrow();
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
    await symlink(dir, join(root, 'linked'));
    await expect(service.createFile(join(root, 'linked', 'escape.tex'), projectId)).rejects.toThrow(
      'Symbolic links',
    );
    const snapshot = await service.createFile(join(root, '章节', 'new.tex'), projectId);
    expect(snapshot?.files.some((f) => f.path === '章节/new.tex')).toBe(true);
    expect(await readFile(join(root, '章节', 'new.tex'), 'utf8')).toBe('');
  });
  it('saves, checkpoints, reopens and retains stable IDs on non-ASCII rename', async () => {
    const id = service.snapshot().files[0].id;
    await service.command(await edit('new text'));
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('new text');
    await service.command({ type: 'rename', fileId: id, path: '章节/导论.tex' });
    store.close();
    store = new MetadataStore(join(dir, 'data'));
    service = new ProjectService(store);
    await service.current();
    const reopened = await service.command({ type: 'load', fileId: id });
    expect(reopened?.files[0]).toMatchObject({
      id,
      path: '章节/导论.tex',
      text: 'new text',
      saved: true,
    });
  });
  it('merges disjoint edits and suppresses duplicate observations', async () => {
    const command = await edit('ALPHA\nbeta\ngamma\n');
    await writeFile(join(root, 'main.tex'), 'alpha\nbeta\nGAMMA\n');
    await service.command(command);
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n');
    const before = service.snapshot().files[0].update;
    await service.command({ type: 'refresh' });
    expect(service.snapshot().files[0].update).toEqual(before);
  });
  it('preserves overlap inputs and resolves explicitly', async () => {
    const command = await edit('human\nbeta\ngamma\n');
    await writeFile(join(root, 'main.tex'), 'external\nbeta\ngamma\n');
    await service.command(command);
    let f = service.snapshot().files[0];
    expect(f).toMatchObject({
      conflict: true,
      text: 'human\nbeta\ngamma\n',
      disk: 'external\nbeta\ngamma\n',
      baseline: 'alpha\nbeta\ngamma\n',
      saved: false,
    });
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toContain('external');
    await service.command({
      type: 'resolve',
      fileId: f.id,
      choice: 'local',
      disk: f.disk,
      diskRevision: f.diskRevision,
    });
    f = service.snapshot().files[0];
    expect(f.saved).toBe(true);
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toContain('human');
  });
  it('retains recovery after interrupted atomic write and detects reopen divergence', async () => {
    const command = await edit('human');
    const fs = await import('node:fs');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('interrupted'));
    await expect(service.command(command)).rejects.toThrow('interrupted');
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toContain('alpha');
    await writeFile(join(root, 'main.tex'), 'external');
    store.close();
    store = new MetadataStore(join(dir, 'data'));
    service = new ProjectService(store);
    await service.open(root);
    await service.command({ type: 'load', fileId: service.snapshot().files[0].id });
    expect(service.snapshot().files[0]).toMatchObject({
      text: 'human',
      disk: 'external',
      conflict: true,
    });
  });
  it('detects external rename and deletion, restores deleted binary assets', async () => {
    const id = service.snapshot().files[0].id;
    await rename(join(root, 'main.tex'), join(root, 'moved.tex'));
    await service.command({ type: 'refresh' });
    expect(service.snapshot().files[0]).toMatchObject({ id, path: 'moved.tex' });
    await rm(join(root, 'moved.tex'));
    await service.command({ type: 'refresh' });
    expect(service.snapshot().files[0].conflict).toBe(true);
    await service.command({
      type: 'resolve',
      fileId: id,
      choice: 'local',
      disk: null,
      diskRevision: service.snapshot().files[0].diskRevision,
    });
    expect(await readFile(join(root, 'moved.tex'), 'utf8')).toContain('alpha');
    await writeFile(join(root, 'image.bin'), Buffer.from([0, 255, 3]));
    await service.command({ type: 'refresh' });
    const asset = service.snapshot().files.find((f) => f.path === 'image.bin')!;
    await service.command({ type: 'delete', fileId: asset.id });
    await service.command({ type: 'restore', fileId: asset.id });
    expect(await readFile(join(root, 'image.bin'))).toEqual(Buffer.from([0, 255, 3]));
  });
  it('rejects traversal, symlinks and overwrite on file operations', async () => {
    expect(projectCommandSchema.safeParse({ type: 'create', path: '../escape' }).success).toBe(
      false,
    );
    await symlink(dir, join(root, 'escape'));
    await expect(service.command({ type: 'create', path: 'escape/stolen' })).rejects.toThrow(
      'Symbolic',
    );
    await expect(service.command({ type: 'create', path: 'main.tex' })).rejects.toThrow();
  });
  it('imports ordinary folders and safe ZIPs without altering sources', async () => {
    await writeFile(
      join(dir, 'paper.zip'),
      zipSync({
        'main.tex': strToU8('\\documentclass{article}'),
        'figures/a.bin': new Uint8Array([0, 1]),
      }),
    );
    await service.importZip(join(dir, 'paper.zip'), join(dir, 'imported'));
    expect(service.snapshot().rootId).not.toBeNull();
    expect(await readFile(join(dir, 'imported/figures/a.bin'))).toEqual(Buffer.from([0, 1]));
    await writeFile(join(dir, 'bad.zip'), zipSync({ '../escape': strToU8('bad') }));
    await expect(service.importZip(join(dir, 'bad.zip'), join(dir, 'bad'))).rejects.toThrow();
    await service.importFolder(root, join(dir, 'copied'));
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });
  it('excludes Git metadata from ZIP imports like folder imports', async () => {
    const files = {
      'main.tex': strToU8('Synthetic paper'),
      'figures/a.bin': new Uint8Array([0, 255, 3]),
      '.git/config': strToU8('[core]\n\tbare = false\n'),
    };
    const source = join(dir, 'source');
    for (const [path, bytes] of Object.entries(files)) {
      await mkdir(join(source, path, '..'), { recursive: true });
      await writeFile(join(source, path), bytes);
    }
    const archive = join(dir, 'metadata.zip');
    await writeFile(archive, zipSync(files));
    for (const kind of ['folder', 'zip']) {
      const destination = join(dir, kind);
      if (kind === 'folder') await service.importFolder(source, destination);
      else await service.importZip(archive, destination);
      expect(await readFile(join(destination, 'main.tex'), 'utf8')).toBe('Synthetic paper');
      expect(await readFile(join(destination, 'figures/a.bin'))).toEqual(Buffer.from([0, 255, 3]));
      await expect(fs.lstat(join(destination, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(source, '.git/config'))).toEqual(Buffer.from(files['.git/config']));
  });
  it('persists preferences and rejects newer metadata versions', async () => {
    await service.command({ type: 'preferences', value: '{"font":14}' });
    await service.open(root);
    await service.command({ type: 'load', fileId: service.snapshot().files[0].id });
    expect(service.snapshot().preferences).toBe('{"font":14}');
    store.db.exec('PRAGMA user_version=99');
    expect(() => new MetadataStore(join(dir, 'data'))).toThrow('newer');
  });
});
it('reconciliation refuses overlap, handles inserts and leaves compatible changes', () => {
  expect(reconcile('abc', 'axc', 'ayc')).toBeNull();
  expect(reconcile('abc', 'xabc', 'abcy')).toBe('xabcy');
});

it('uses an acknowledged baseline when disk was observed before a stale replica arrives', async () => {
  const command = await edit('human\nbeta\ngamma\n');
  await writeFile(join(root, 'main.tex'), 'external\nbeta\ngamma\n');
  await service.command({ type: 'refresh' });
  await service.command(command);
  expect(service.snapshot().files[0]).toMatchObject({
    text: 'human\nbeta\ngamma\n',
    conflict: true,
    disk: 'external\nbeta\ngamma\n',
  });
});
it('ranks fuzzy filenames and source locations with bounded, correctly cropped highlight ranges', async () => {
  await writeFile(
    join(root, 'z-introduction.tex'),
    '🧪 İ 章节\n' + 'x'.repeat(300) + ' Introduction\nIntroduction again.',
  );
  await writeFile(join(root, 'a-approximate.tex'), 'Introductoin');
  const result = await service.command({ type: 'search', query: 'Introduction' });
  expect(
    result?.hits?.filter((hit) => hit.kind === 'content').map((hit) => hit.approximate),
  ).toEqual([false, false, true]);
  const longLine = result?.hits?.find((hit) => hit.kind === 'content' && hit.line === 2)!;
  expect(longLine.snippet.startsWith('…')).toBe(true);
  expect(longLine.ranges.map((range) => longLine.snippet.slice(range.from, range.to))).toEqual([
    'Introduction',
  ]);
  expect(longLine.offset).toBeGreaterThan(300);
  expect(longLine.length).toBe('Introduction'.length);
  const file = await service.command({ type: 'search', query: 'mtex' });
  expect(file?.hits?.[0]).toMatchObject({
    path: 'main.tex',
    kind: 'path',
    offset: 0,
    length: 0,
    approximate: true,
  });
  expect(
    file?.hits?.[0].pathRanges.map((range) => 'main.tex'.slice(range.from, range.to)).join(''),
  ).toBe('mtex');
  const empty = await service.command({ type: 'search', query: '  ' });
  expect(empty?.hits).toEqual([]);
});

it('bounds ranked search globally and per file while retaining late exact matches', async () => {
  store.index(
    root,
    Array.from({ length: 220 }, (_, i) => ({
      id: `file-${i}`,
      path: `${i === 219 ? 'z-exact' : String(i).padStart(3, '0')}.tex`,
      content: (i === 219 ? 'Introduction ' : 'Introductoin ').repeat(30),
    })),
  );
  const hits = store.hits(root, 'Introduction');
  expect(hits).toHaveLength(200);
  expect(hits[0].path).toBe('z-exact.tex');
  expect(hits.filter((hit) => hit.fileId === 'file-219')).toHaveLength(20);
});

it('loads only requested document payloads and rebuilds derived search indexes', async () => {
  await writeFile(join(root, 'second.tex'), 'searchable phrase');
  await service.command({ type: 'refresh' });
  let snap = service.snapshot();
  const second = snap.files.find((f) => f.path === 'second.tex')!;
  expect(second.loaded).toBe(false);
  expect(second.update).toEqual([]);
  const result = await service.command({ type: 'search', query: 'searchable phrase' });
  expect(result?.matches).toEqual([second.id]);
  await service.command({ type: 'load', fileId: second.id });
  snap = service.snapshot();
  expect(snap.files.find((f) => f.path === 'main.tex')?.update).toEqual([]);
  expect(snap.files.find((f) => f.id === second.id)?.text).toBe('searchable phrase');
  store.db.exec('DELETE FROM file_index');
  await service.command({ type: 'refresh' });
  expect((await service.command({ type: 'search', query: 'searchable' }))?.matches).toEqual([
    second.id,
  ]);
});
it('distinguishes binary replacement from deletion and requires its current revision', async () => {
  const id = service.snapshot().files[0].id;
  await writeFile(join(root, 'main.tex'), Buffer.from([0, 255, 1]));
  await service.command({ type: 'refresh' });
  let f = service.snapshot().files[0];
  expect(f).toMatchObject({ conflict: true, diskKind: 'binary', deleted: false });
  await expect(
    service.command({
      type: 'resolve',
      fileId: id,
      choice: 'disk',
      disk: null,
      diskRevision: 'old',
    }),
  ).rejects.toThrow('changed again');
  await service.command({
    type: 'resolve',
    fileId: id,
    choice: 'local',
    disk: null,
    diskRevision: f.diskRevision,
  });
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toContain('alpha');
  await writeFile(join(root, 'main.tex'), Buffer.from([0, 255, 2]));
  await service.command({ type: 'refresh' });
  f = service.snapshot().files[0];
  await service.command({
    type: 'resolve',
    fileId: id,
    choice: 'disk',
    disk: null,
    diskRevision: f.diskRevision,
  });
  expect(service.snapshot().files[0]).toMatchObject({
    conflict: false,
    deleted: false,
    text: null,
  });
  expect(await readFile(join(root, 'main.tex'))).toEqual(Buffer.from([0, 255, 2]));
});
it('retains a deletion checkpoint when unlink succeeds but completion is interrupted', async () => {
  const id = service.snapshot().files[0].id;
  await service.command({ type: 'delete', fileId: id });
  const raw = JSON.parse(store.load(root)!);
  raw.files[0].deleted = false;
  store.save(root, JSON.stringify(raw));
  await service.open(root);
  await service.command({ type: 'restore', fileId: id });
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toContain('alpha');
});
it('does not merge a folder import into an existing destination', async () => {
  const dest = join(dir, 'existing');
  await mkdir(dest);
  await writeFile(join(dest, 'precious'), 'keep');
  await expect(service.importFolder(root, dest)).rejects.toThrow();
  expect(await readFile(join(dest, 'precious'), 'utf8')).toBe('keep');
});

it('migrates schema v1 to v3 without losing recoverable project identity', async () => {
  const id = service.snapshot().id;
  store.db.exec('DROP TABLE file_index; DROP TABLE project_library; PRAGMA user_version=1;');
  store.close();
  store = new MetadataStore(join(dir, 'data'));
  service = new ProjectService(store);
  expect((await service.current())?.id).toBe(id);
  expect(store.search(root, 'alpha')).toHaveLength(1);
});
it('retains the old project when opening a new folder fails', async () => {
  const original = service.snapshot();
  const unavailable = join(dir, 'new-project');
  await mkdir(unavailable);
  await writeFile(join(unavailable, 'other.tex'), 'other');
  const scan = vi.spyOn(store, 'index').mockImplementationOnce(() => {
    throw new Error('index unavailable');
  });
  await expect(service.open(unavailable)).rejects.toThrow('unavailable');
  scan.mockRestore();
  expect(service.snapshot().id).toBe(original.id);
  expect(store.get('lastProject')).toBe(root);
  await service.command(await edit('old project remains editable'));
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('old project remains editable');
});

// Native sample/recovery actions use the same real filesystem and recovery service.
it('preserves editable sample copies and validates opening the main document folder', async () => {
  const base = await mkdtemp(join(tmpdir(), 'loom-sample-'));
  const sampleStore = new MetadataStore(join(base, 'metadata'));
  const sampleService = new ProjectService(sampleStore);
  try {
    const source = join(base, 'original');
    await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'nested', 'main.tex'), '\\documentclass{article}');
    await writeFile(join(source, 'nested', 'other.tex'), '\\documentclass{article}');
    const destination = join(base, 'samples', 'Paper');
    const first = await sampleService.openSample(source, destination);
    await writeFile(
      join(destination, 'nested', 'main.tex'),
      '\\documentclass{article}\n% my edits',
    );
    const reopened = await sampleService.openSample(source, destination);
    expect(reopened.id).toBe(first.id);
    expect(await readFile(join(destination, 'nested', 'main.tex'), 'utf8')).toContain('% my edits');
    await expect(sampleService.openMainFolder('other-project')).rejects.toThrow();
    const selected = reopened.files.find((file) => file.path === 'nested/main.tex')!;
    await sampleService.command({ type: 'root', fileId: selected.id });
    const paper = await sampleService.openMainFolder(reopened.id);
    expect(paper.name).toBe('nested');
    expect(paper.files.find((file) => file.id === paper.rootId)?.path).toBe('main.tex');
    await expect(sampleService.openMainFolder(paper.id)).rejects.toThrow('paper folder');
  } finally {
    sampleStore.close();
    await rm(base, { recursive: true, force: true });
  }
});
