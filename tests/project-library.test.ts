import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename, readFile, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../src/services/project/store';
import { ServiceController, type ServiceTransport } from '../src/main/service-controller';
import { ProjectService } from '../src/services/project/projects';
import { projectCommandSchema, projectResultSchema } from '../src/contracts/project';
let directory: string;
let store: MetadataStore;
afterEach(async () => {
  store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('retains separate project identities and preferences across reopen, and keeps missing folders in the library', async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-library-'));
  store = new MetadataStore(join(directory, 'data'));
  let service = new ProjectService(store);
  const a = await service.create(join(directory, 'Paper A'));
  await service.command({ type: 'preferences', value: '{"font":19,"active":"saved"}' });
  const b = await service.create(join(directory, 'Paper B'));
  expect(a.id).not.toBe(b.id);
  store.close();
  store = new MetadataStore(join(directory, 'data'));
  service = new ProjectService(store);
  expect(await service.library()).toHaveLength(2);
  expect(await service.reopen(a.id)).toMatchObject({
    id: a.id,
    preferences: '{"font":19,"active":"saved"}',
  });
  expect(await service.reopen(b.id)).toMatchObject({ id: b.id, preferences: null });
  await rm(join(directory, 'Paper A'), { recursive: true });
  expect((await service.library()).find((p) => p.id === a.id)).toMatchObject({ available: false });
  await expect(service.reopen(a.id)).rejects.toThrow('recovery data has been retained');
  expect(service.snapshot().id).toBe(b.id);
  await rm(join(directory, 'Paper B'), { recursive: true });
  await expect(
    service.command({ type: 'preferences', value: '{"font":17}' }),
  ).resolves.toMatchObject({ preferences: '{"font":17}' });
  expect(store.load(join(directory, 'Paper A'))).not.toBeNull();
  const restarted = new ProjectService(store);
  expect(await restarted.current(true)).toBeNull();
  await restarted.create(join(directory, 'Paper C'));
  expect(await restarted.library()).toHaveLength(3);
  expect(
    projectResultSchema.safeParse({ ok: true, value: null, library: await service.library() })
      .success,
  ).toBe(true);
  expect(
    projectCommandSchema.safeParse({ type: 'reopen', projectId: a.id, path: '/untrusted' }).success,
  ).toBe(false);
});
it('migrates existing metadata into the library without opening or rewriting manuscripts', async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-library-'));
  const paper = join(directory, 'Legacy');
  await mkdir(paper);
  await writeFile(join(paper, 'main.tex'), 'Synthetic manuscript');
  store = new MetadataStore(join(directory, 'data'));
  const service = new ProjectService(store);
  const opened = await service.open(paper);
  store.db.exec('DROP TABLE project_library; PRAGMA user_version=2');
  store.close();
  store = new MetadataStore(join(directory, 'data'));
  expect(await new ProjectService(store).library()).toEqual([
    expect.objectContaining({
      id: opened.id,
      name: 'Legacy',
      path: paper,
      lastOpened: 0,
      available: true,
    }),
  ]);
  expect(store.load(paper)).not.toBeNull();
});

it('trashes only a closed project, keeps failures and recovery, and reopens a restored directory', async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-trash-'));
  store = new MetadataStore(join(directory, 'data'));
  const service = new ProjectService(store);
  const path = join(directory, 'Paper A');
  const a = await service.create(path);
  await service.command({ type: 'preferences', value: '{"font":19}' });
  const b = await service.create(join(directory, 'Paper B'));
  const failure = vi.fn(async () => {
    throw new Error('Trash unavailable');
  });
  await expect(service.removeProject(a.id, 'trash', failure)).rejects.toThrow('Trash unavailable');
  expect(await service.library()).toHaveLength(2);
  await access(join(path, 'main.tex'));
  const trashed = join(directory, 'synthetic-trash');
  await service.removeProject(a.id, 'trash', async (target) => {
    expect(target).toBe(path);
    await rename(target, trashed);
  });
  expect((await service.library()).map((p) => p.id)).toEqual([b.id]);
  expect(await readFile(join(directory, 'Paper B', 'main.tex'), 'utf8')).toContain('documentclass');
  expect(store.load(path)).not.toBeNull();
  await rename(trashed, path);
  expect(await service.open(path)).toMatchObject({ id: a.id, preferences: '{"font":19}' });
});

it('protects the active project, its parent, symlink replacements and unsaved recovery', async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-trash-'));
  store = new MetadataStore(join(directory, 'data'));
  const service = new ProjectService(store);
  const parent = await service.create(join(directory, 'Parent'));
  const nested = await service.create(join(directory, 'Parent', 'Nested'));
  const trash = vi.fn(async () => {});
  await expect(service.removeProject(nested.id, 'trash', trash)).rejects.toThrow('open');
  await expect(service.removeProject(parent.id, 'trash', trash)).rejects.toThrow('open');
  expect((await service.library()).every((p) => p.deleteBlockedReason)).toBe(true);
  const a = await service.create(join(directory, 'Unsaved'));
  const stored = JSON.parse(store.load(join(directory, 'Unsaved'))!);
  stored.files[0].conflict = true;
  store.save(join(directory, 'Unsaved'), JSON.stringify(stored));
  // Switch without overwriting the recovery record from the prior live instance.
  const restarted = new ProjectService(store);
  await restarted.create(join(directory, 'Other'));
  await expect(restarted.removeProject(a.id, 'trash', trash)).rejects.toThrow('save or resolve');
  const symlinked = await restarted.create(join(directory, 'Replaced'));
  await restarted.reopen(nested.id);
  await rename(join(directory, 'Replaced'), join(directory, 'Original'));
  await symlink(join(directory, 'Original'), join(directory, 'Replaced'));
  await expect(restarted.removeProject(symlinked.id, 'trash', trash)).rejects.toThrow(
    'unavailable',
  );
  expect(trash).not.toHaveBeenCalled();
});

it('removes only unavailable entries from the list and rejects arbitrary renderer paths', async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-trash-'));
  store = new MetadataStore(join(directory, 'data'));
  const service = new ProjectService(store);
  const a = await service.create(join(directory, 'Missing'));
  await service.create(join(directory, 'Current'));
  const trash = vi.fn(async () => {});
  await expect(service.removeProject(a.id, 'forget', trash)).rejects.toThrow('available');
  await rm(join(directory, 'Missing'), { recursive: true });
  await expect(service.removeProject(a.id, 'trash', trash)).rejects.toThrow('unavailable');
  await service.removeProject(a.id, 'forget', trash);
  expect(await service.library()).toHaveLength(1);
  expect(store.load(join(directory, 'Missing'))).not.toBeNull();
  expect(trash).not.toHaveBeenCalled();
  expect(
    projectCommandSchema.safeParse({ type: 'trash-project', projectId: a.id, path: directory })
      .success,
  ).toBe(false);
});

it('closes the last project without losing metadata and then permits Trash', async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-close-'));
  store = new MetadataStore(join(directory, 'data'));
  const service = new ProjectService(store);
  const paper = await service.create(join(directory, 'Only paper'));
  await expect(service.closeProject('stale-id')).rejects.toThrow('changed');
  await service.closeProject(paper.id);
  expect(service.nativeLocation()).toBeNull();
  expect(await service.current()).toBeNull();
  expect(store.load(join(directory, 'Only paper'))).not.toBeNull();
  expect((await service.library())[0].deleteBlockedReason).toBeUndefined();
  await service.removeProject(paper.id, 'trash', async (path) =>
    rename(path, join(directory, 'trash')),
  );
  expect(await service.library()).toHaveLength(0);
});

it('keeps native Trash pending beyond the normal request deadline and reports callback failure', async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-trash-controller-'));
  store = new MetadataStore(join(directory, 'data'));
  vi.useFakeTimers();
  const messages: unknown[] = [];
  let receive: (message: unknown) => void = () => {};
  let rejectTrash: (error: Error) => void = () => {};
  const transport: ServiceTransport = {
    postMessage: (message) => {
      messages.push(message);
    },
    onMessage: (listener) => {
      receive = listener;
    },
    onExit: () => {},
    onError: () => {},
    kill: () => {},
  };
  const controller = new ServiceController(
    () => transport,
    5_000,
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectTrash = reject;
      }),
  );
  try {
    const startup = controller.start();
    receive({ type: 'ready', pid: 42, version: '0.1.0' });
    await startup;
    const operation = controller.project({ type: 'trash-project', projectId: 'closed' });
    await Promise.resolve();
    const command = messages.at(-1) as { id: string };
    receive({ type: 'trash-project', id: command.id, path: '/owned/project' });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(messages).toHaveLength(1);
    rejectTrash(new Error('OS rejected Trash'));
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.at(-1)).toMatchObject({
      type: 'trash-project-result',
      id: command.id,
      error: expect.stringContaining('retained'),
    });
    receive({
      type: 'project-result',
      id: command.id,
      result: {
        ok: false,
        error: { code: 'PROJECT_ERROR', message: 'Trash failed', retryable: true },
      },
    });
    expect(await operation).toMatchObject({ ok: false });
    receive({ type: 'trash-project', id: 'expired', path: '/never/trash' });
    expect(messages.at(-1)).toMatchObject({
      type: 'trash-project-result',
      id: 'expired',
      error: expect.stringContaining('expired'),
    });
  } finally {
    vi.useRealTimers();
  }
});

it('blocks reuse of a folder with an unknown native Trash outcome until restart', async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-trash-unknown-'));
  store = new MetadataStore(join(directory, 'data'));
  const service = new ProjectService(store);
  const path = join(directory, 'Uncertain');
  const paper = await service.create(path);
  await service.create(join(directory, 'Sibling'));
  const error = new Error('Native reply timed out');
  error.name = 'TrashOutcomeUnknown';
  await expect(
    service.removeProject(paper.id, 'trash', async () => {
      throw error;
    }),
  ).rejects.toThrow('timed out');
  await expect(service.open(path)).rejects.toThrow('not confirmed');
  expect((await service.library()).find((entry) => entry.id === paper.id)).toMatchObject({
    deleteBlockedReason: expect.stringContaining('did not reply'),
  });
  expect(await service.current()).not.toBeNull();
  expect(store.load(path)).not.toBeNull();
});
