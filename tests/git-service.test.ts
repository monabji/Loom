import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitResultSchema } from '../src/contracts/git';
import { cloneRepository, GitService } from '../src/services/git/service';
import { findExecutable, runTool } from '../src/services/latex/tools';
import { createTestSymlink } from './helpers/symlink';

const roots: string[] = [];
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'loom-git-'));
  roots.push(root);
  const git = await findExecutable('git');
  if (!git) return null;
  for (const args of [
    ['init', '-q', root],
    ['-C', root, 'config', 'user.name', 'Loom Test'],
    ['-C', root, 'config', 'user.email', 'loom@example.invalid'],
  ]) {
    const result = await runTool(git, args);
    if (result.code !== 0) throw new Error(result.output);
  }
  return { root, git };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Git status and diff service', () => {
  it('refuses to commit staged files outside a nested open project', async () => {
    const setup = await repository();
    if (!setup) return;
    const project = join(setup.root, 'paper');
    await mkdir(project);
    await writeFile(join(project, 'main.tex'), 'paper\n');
    await writeFile(join(setup.root, 'outside.txt'), 'outside\n');
    expect((await runTool(setup.git, ['-C', setup.root, 'add', '.'])).code).toBe(0);
    const service = new GitService(() => ({ root: project, projectId: 'p', paths: ['main.tex'] }));
    const state = await service.command({ type: 'status', projectId: 'p' });
    if (state.kind !== 'status' || !state.indexTree) throw new Error('Missing index tree');
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'paper',
        expectedIndexTree: state.indexTree,
      }),
    ).rejects.toThrow('staged files outside this project');
    expect(
      (await runTool(setup.git, ['-C', setup.root, 'rev-parse', '--verify', 'HEAD'])).code,
    ).not.toBe(0);
  });
  it.each([
    ['outside.tex', 'paper/renamed.tex'],
    ['paper/inside.tex', 'outside-renamed.tex'],
  ])(
    'blocks a staged rename across the project boundary from %s to %s',
    async (source, destination) => {
      const setup = await repository();
      if (!setup) return;
      await mkdir(join(setup.root, 'paper'));
      await writeFile(join(setup.root, source), 'rename content\n');
      for (const args of [
        ['add', '.'],
        ['commit', '-qm', 'base'],
      ])
        expect((await runTool(setup.git, ['-C', setup.root, ...args])).code).toBe(0);
      const head = (await runTool(setup.git, ['-C', setup.root, 'rev-parse', 'HEAD'])).stdout;
      expect((await runTool(setup.git, ['-C', setup.root, 'mv', source, destination])).code).toBe(
        0,
      );
      const service = new GitService(() => ({
        root: join(setup.root, 'paper'),
        projectId: 'p',
        paths: ['renamed.tex', 'inside.tex'],
      }));
      const state = await service.command({ type: 'status', projectId: 'p' });
      if (state.kind !== 'status' || !state.indexTree) throw new Error('Missing tree');
      if (source === 'outside.tex')
        expect(state.files).toContainEqual(
          expect.objectContaining({ originalPath: source, crossesProjectBoundary: true }),
        );
      await expect(
        service.command({
          type: 'commit',
          projectId: 'p',
          message: 'rename',
          expectedIndexTree: state.indexTree,
        }),
      ).rejects.toThrow('staged files outside this project');
      expect((await runTool(setup.git, ['-C', setup.root, 'rev-parse', 'HEAD'])).stdout).toBe(head);
    },
  );

  it('validates staged and unstaged type changes through the response contract', async ({
    skip,
  }) => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'main.tex'), 'text\n');
    await runTool(setup.git, ['-C', setup.root, 'add', '.']);
    await runTool(setup.git, ['-C', setup.root, 'commit', '-qm', 'base']);
    await rm(join(setup.root, 'main.tex'));
    if (!(await createTestSymlink('target', join(setup.root, 'main.tex'))))
      skip('This Windows host does not permit symbolic links.');
    const service = new GitService(() => ({ root: setup.root, projectId: 'p', paths: [] }));
    for (const area of ['worktree', 'index'] as const) {
      if (area === 'index') await runTool(setup.git, ['-C', setup.root, 'add', 'main.tex']);
      const state = await service.command({ type: 'status', projectId: 'p' });
      expect(gitResultSchema.safeParse({ ok: true, value: state }).success).toBe(true);
      expect(state).toMatchObject({ files: [expect.objectContaining({ [area]: 'T' })] });
    }
  });

  it('finishes an ours-only merge but blocks unresolved and ordinary empty commits', async () => {
    const setup = await repository();
    if (!setup) return;
    const git = async (...args: string[]) => runTool(setup.git, ['-C', setup.root, ...args]);
    await writeFile(join(setup.root, 'main.tex'), 'base\n');
    await git('add', '.');
    await git('commit', '-qm', 'base');
    await git('branch', 'theirs');
    await git('switch', 'theirs');
    await writeFile(join(setup.root, 'main.tex'), 'theirs\n');
    await git('commit', '-qam', 'theirs');
    await git('switch', '-');
    await writeFile(join(setup.root, 'main.tex'), 'ours\n');
    await git('commit', '-qam', 'ours');
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: ['main.tex'],
    }));
    const initial = await service.command({ type: 'status', projectId: 'p' });
    if (initial.kind !== 'status' || !initial.indexTree) throw new Error('Missing tree');
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'empty',
        expectedIndexTree: initial.indexTree,
      }),
    ).rejects.toThrow('no staged changes');
    expect((await git('merge', 'theirs')).code).toBe(1);
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'unresolved',
        expectedIndexTree: initial.indexTree,
      }),
    ).rejects.toThrow();
    const resolved = await service.command({
      type: 'resolve',
      projectId: 'p',
      path: 'main.tex',
      choice: 'ours',
    });
    if (resolved.kind !== 'status' || !resolved.indexTree) throw new Error('Missing tree');
    expect(resolved).toMatchObject({ mergeInProgress: true, files: [] });
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'merge ours',
        expectedIndexTree: resolved.indexTree,
      }),
    ).resolves.toMatchObject({ mergeInProgress: false });
    expect(
      (await git('rev-list', '--parents', '-n', '1', 'HEAD')).stdout.trim().split(' '),
    ).toHaveLength(3);
  }, 120_000);

  it('preserves whitespace in a repository root path', async () => {
    const setup = await repository();
    if (!setup) return;
    // Win32 cannot use paths ending in a space as a process working directory.
    const root = join(setup.root, process.platform === 'win32' ? 'repo name' : 'repo ');
    await mkdir(root);
    await runTool(setup.git, ['init', '-q', root]);
    await runTool(setup.git, ['-C', root, 'config', 'user.name', 'Test']);
    await runTool(setup.git, ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(root, 'main.tex'), 'text');
    await runTool(setup.git, ['-C', root, 'add', '.']);
    const service = new GitService(() => ({ root, projectId: 'p', paths: ['main.tex'] }));
    const state = await service.command({ type: 'status', projectId: 'p' });
    expect(state).toMatchObject({
      repositoryPrefix: '',
      files: [expect.objectContaining({ path: 'main.tex' })],
    });
    if (state.kind !== 'status' || !state.indexTree) throw new Error('Missing tree');
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'commit',
        expectedIndexTree: state.indexTree,
      }),
    ).resolves.toMatchObject({ repository: true });
  }, 120_000);

  it('rejects externally staged gitlinks before committing', async () => {
    const setup = await repository();
    if (!setup) return;
    const nested = join(setup.root, 'nested');
    await mkdir(nested);
    await runTool(setup.git, ['init', '-q', nested]);
    await runTool(setup.git, ['-C', nested, 'config', 'user.name', 'Test']);
    await runTool(setup.git, ['-C', nested, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(join(nested, '.env'), 'synthetic secret');
    await runTool(setup.git, ['-C', nested, 'add', '.']);
    await runTool(setup.git, ['-C', nested, 'commit', '-qm', 'nested']);
    expect((await runTool(setup.git, ['-C', setup.root, 'add', 'nested'])).code).toBe(0);
    const service = new GitService(() => ({ root: setup.root, projectId: 'p', paths: ['nested'] }));
    const state = await service.command({ type: 'status', projectId: 'p' });
    if (state.kind !== 'status' || !state.indexTree) throw new Error('Missing tree');
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'gitlink',
        expectedIndexTree: state.indexTree,
      }),
    ).rejects.toThrow('gitlinks');
    expect(
      (await runTool(setup.git, ['-C', setup.root, 'rev-parse', '--verify', 'HEAD'])).code,
    ).not.toBe(0);
  });

  it.each(['config', 'gitmodules'])(
    'blocks staged gitlinks when %s ignores submodules',
    async (setting) => {
      const setup = await repository();
      if (!setup) return;
      const run = async (...args: string[]) => {
        const result = await runTool(setup.git, ['-C', setup.root, ...args]);
        expect(result.code, result.output).toBe(0);
        return result.stdout.trim();
      };
      await writeFile(join(setup.root, 'main.tex'), 'base\n');
      await run('add', 'main.tex');
      await run('commit', '-qm', 'base');
      const head = await run('rev-parse', 'HEAD');
      await run('update-index', '--add', '--cacheinfo', '160000', head, 'nested');
      await writeFile(join(setup.root, 'main.tex'), 'updated\n');
      await run('add', 'main.tex');
      if (setting === 'config') await run('config', 'diff.ignoreSubmodules', 'all');
      else
        await writeFile(
          join(setup.root, '.gitmodules'),
          '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n\tignore = all\n',
        );
      const service = new GitService(() => ({
        root: setup.root,
        projectId: 'p',
        paths: ['main.tex', 'nested'],
      }));
      const state = await service.command({ type: 'status', projectId: 'p' });
      if (state.kind !== 'status' || !state.indexTree) throw new Error('Missing tree');
      await expect(
        service.command({
          type: 'commit',
          projectId: 'p',
          message: 'unsafe',
          expectedIndexTree: state.indexTree,
        }),
      ).rejects.toThrow('gitlinks');
      expect(await run('rev-parse', 'HEAD')).toBe(head);
    },
  );

  it('reports branch, untracked Unicode paths, and distinct index/worktree diffs', async () => {
    const setup = await repository();
    if (!setup) return;
    const path = 'draft λ.tex';
    await writeFile(join(setup.root, path), 'first line\n');
    let result = await runTool(setup.git, ['-C', setup.root, 'add', '--', path]);
    expect(result.code).toBe(0);
    result = await runTool(setup.git, ['-C', setup.root, 'commit', '-qm', 'baseline']);
    expect(result.code).toBe(0);
    await writeFile(join(setup.root, path), 'staged line\n');
    result = await runTool(setup.git, ['-C', setup.root, 'add', '--', path]);
    expect(result.code).toBe(0);
    await writeFile(join(setup.root, path), 'working line\n');
    await writeFile(join(setup.root, 'new notes.md'), 'not staged\n');
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: [path, 'new notes.md'],
    }));
    const status = await service.command({ type: 'status', projectId: 'p' });
    expect(status).toMatchObject({
      kind: 'status',
      repository: true,
      branch: expect.any(String),
      files: expect.arrayContaining([
        expect.objectContaining({ path, index: 'M', worktree: 'M' }),
        expect.objectContaining({ path: 'new notes.md', index: '?', worktree: '?' }),
      ]),
    });
    const index = await service.command({ type: 'diff', projectId: 'p', path, area: 'index' });
    const worktree = await service.command({
      type: 'diff',
      projectId: 'p',
      path,
      area: 'worktree',
    });
    expect(index).toMatchObject({ kind: 'diff', text: expect.stringContaining('staged line') });
    expect(worktree).toMatchObject({ kind: 'diff', text: expect.stringContaining('working line') });
    const untracked = await service.command({
      type: 'diff',
      projectId: 'p',
      path: 'new notes.md',
      area: 'worktree',
    });
    expect(untracked).toMatchObject({ kind: 'diff', text: expect.stringContaining('not staged') });
  });

  it('does not treat an ordinary project folder as a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loom-no-git-'));
    roots.push(root);
    const service = new GitService(() => ({ root, projectId: 'p', paths: [] }));
    await expect(service.command({ type: 'status', projectId: 'p' })).resolves.toMatchObject({
      kind: 'status',
      repository: false,
    });
  });

  it('stages only the chosen path and rejects a commit after the reviewed index changes', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'a.tex'), 'old a\n');
    await writeFile(join(setup.root, 'b.tex'), 'old b\n');
    let result = await runTool(setup.git, ['-C', setup.root, 'add', '--', 'a.tex', 'b.tex']);
    expect(result.code).toBe(0);
    result = await runTool(setup.git, ['-C', setup.root, 'commit', '-qm', 'baseline']);
    expect(result.code).toBe(0);
    await writeFile(join(setup.root, 'a.tex'), 'new a\n');
    await writeFile(join(setup.root, 'b.tex'), 'new b\n');
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: ['a.tex', 'b.tex'],
    }));
    await service.command({ type: 'stage', projectId: 'p', path: 'a.tex' });
    const staged = await service.command({ type: 'status', projectId: 'p' });
    expect(staged).toMatchObject({
      kind: 'status',
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'a.tex', index: 'M', worktree: ' ' }),
        expect.objectContaining({ path: 'b.tex', index: ' ', worktree: 'M' }),
      ]),
    });
    if (staged.kind !== 'status' || !staged.indexTree) throw new Error('Missing index tree.');
    await service.command({ type: 'stage', projectId: 'p', path: 'b.tex' });
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'reviewed a only',
        expectedIndexTree: staged.indexTree,
      }),
    ).rejects.toThrow(/changed after review/);
  });

  it('blocks sensitive staged paths instead of silently changing the index', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, '.env'), 'TOKEN=synthetic\n');
    const result = await runTool(setup.git, ['-C', setup.root, 'add', '--', '.env']);
    expect(result.code).toBe(0);
    const service = new GitService(() => ({ root: setup.root, projectId: 'p', paths: ['.env'] }));
    const status = await service.command({ type: 'status', projectId: 'p' });
    if (status.kind !== 'status' || !status.indexTree) throw new Error('Missing staged tree.');
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'private',
        expectedIndexTree: status.indexTree,
      }),
    ).rejects.toThrow(/may be private/);
    expect(
      await runTool(setup.git, ['-C', setup.root, 'diff', '--cached', '--name-only']),
    ).toMatchObject({ output: '.env\n' });
  });

  it('blocks common disposable TeX outputs from staging and commit review', async () => {
    const setup = await repository();
    if (!setup) return;
    const generated = ['main.aux', 'main.toc', 'main.fls', 'main.fdb_latexmk'];
    for (const path of generated) await writeFile(join(setup.root, path), 'synthetic output\n');
    const service = new GitService(() => ({ root: setup.root, projectId: 'p', paths: generated }));
    for (const path of generated)
      await expect(service.command({ type: 'stage', projectId: 'p', path })).rejects.toThrow(
        /private or generated/,
      );
    expect(
      (await runTool(setup.git, ['-C', setup.root, 'diff', '--cached', '--name-only'])).stdout,
    ).toBe('');
  });

  it('commits only the reviewed index and creates a branch without pushing', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'main.tex'), 'baseline\n');
    let result = await runTool(setup.git, ['-C', setup.root, 'add', '--', 'main.tex']);
    expect(result.code).toBe(0);
    result = await runTool(setup.git, ['-C', setup.root, 'commit', '-qm', 'baseline']);
    expect(result.code).toBe(0);
    await writeFile(join(setup.root, 'main.tex'), 'revision\n');
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: ['main.tex'],
    }));
    await service.command({ type: 'stage', projectId: 'p', path: 'main.tex' });
    const staged = await service.command({ type: 'status', projectId: 'p' });
    if (staged.kind !== 'status' || !staged.indexTree) throw new Error('Missing staged index.');
    const commit = await service.command({
      type: 'commit',
      projectId: 'p',
      message: 'reviewed update',
      expectedIndexTree: staged.indexTree,
    });
    expect(commit).toMatchObject({ kind: 'status', files: [] });
    result = await runTool(setup.git, ['-C', setup.root, 'log', '-1', '--format=%s']);
    expect(result.output.trim()).toBe('reviewed update');
    await service.command({
      type: 'branch',
      projectId: 'p',
      name: 'codex/reviewed-work',
      action: 'create',
    });
    const branch = await service.command({ type: 'status', projectId: 'p' });
    expect(branch).toMatchObject({ kind: 'status', branch: 'codex/reviewed-work' });
  }, 120_000);

  it('clones a local bare remote into a new destination and preserves failure destinations', async () => {
    const git = await findExecutable('git');
    if (!git) return;
    const parent = await mkdtemp(join(tmpdir(), 'loom-clone-'));
    roots.push(parent);
    const source = join(parent, 'source');
    const bare = join(parent, 'remote.git');
    const destination = join(parent, 'paper');
    await mkdir(source);
    await writeFile(join(source, 'main.tex'), 'portable source\n');
    for (const args of [
      ['init', '-q', source],
      ['-C', source, 'config', 'user.name', 'Loom Test'],
      ['-C', source, 'config', 'user.email', 'loom@example.invalid'],
      ['-C', source, 'add', '--', 'main.tex'],
      ['-C', source, 'commit', '-qm', 'portable'],
      ['init', '--bare', '-q', bare],
      ['-C', source, 'remote', 'add', 'origin', bare],
      ['-C', source, 'push', '-qu', 'origin', 'HEAD'],
    ]) {
      const result = await runTool(git, args);
      expect(result.code).toBe(0);
    }
    await cloneRepository(bare, destination);
    expect((await readFile(join(destination, 'main.tex'), 'utf8')).replace(/\r\n/g, '\n')).toBe(
      'portable source\n',
    );
  });

  it('shows merge base/ours/theirs and keeps conflict stages until a resolved file is staged', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'main.tex'), 'base\n');
    let result = await runTool(setup.git, ['-C', setup.root, 'add', '--', 'main.tex']);
    expect(result.code).toBe(0);
    result = await runTool(setup.git, ['-C', setup.root, 'commit', '-qm', 'base']);
    expect(result.code).toBe(0);
    result = await runTool(setup.git, ['-C', setup.root, 'branch', 'theirs']);
    expect(result.code).toBe(0);
    result = await runTool(setup.git, ['-C', setup.root, 'switch', 'theirs']);
    expect(result.code).toBe(0);
    await writeFile(join(setup.root, 'main.tex'), 'theirs\n');
    result = await runTool(setup.git, ['-C', setup.root, 'commit', '-qam', 'theirs']);
    expect(result.code).toBe(0);
    result = await runTool(setup.git, ['-C', setup.root, 'switch', '-']);
    expect(result.code).toBe(0);
    await writeFile(join(setup.root, 'main.tex'), 'ours\n');
    result = await runTool(setup.git, ['-C', setup.root, 'commit', '-qam', 'ours']);
    expect(result.code).toBe(0);
    result = await runTool(setup.git, ['-C', setup.root, 'merge', 'theirs']);
    expect(result.code).toBe(1);
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: ['main.tex'],
    }));
    expect(await service.command({ type: 'status', projectId: 'p' })).toMatchObject({
      kind: 'status',
      mergeInProgress: true,
      files: [expect.objectContaining({ path: 'main.tex', index: 'U' })],
    });
    expect(
      await service.command({ type: 'diff', projectId: 'p', path: 'main.tex', area: 'base' }),
    ).toMatchObject({ text: 'base\n' });
    expect(
      await service.command({ type: 'diff', projectId: 'p', path: 'main.tex', area: 'ours' }),
    ).toMatchObject({ text: 'ours\n' });
    expect(
      await service.command({ type: 'diff', projectId: 'p', path: 'main.tex', area: 'theirs' }),
    ).toMatchObject({ text: 'theirs\n' });
    await expect(
      service.command({ type: 'resolve', projectId: 'p', path: 'main.tex', choice: 'working' }),
    ).rejects.toThrow(/markers remain/);
    await writeFile(join(setup.root, 'main.tex'), 'resolved\n');
    const resolved = await service.command({
      type: 'resolve',
      projectId: 'p',
      path: 'main.tex',
      choice: 'working',
    });
    expect(resolved).toMatchObject({
      kind: 'status',
      mergeInProgress: true,
      files: [expect.objectContaining({ path: 'main.tex', index: 'M', worktree: ' ' })],
    });
  });

  it('treats wildcard pathspec characters literally and leaves unrelated private files unstaged', async () => {
    const setup = await repository();
    if (!setup) return;
    const literalPath = '[literal].tex';
    await writeFile(join(setup.root, literalPath), 'literal name\n');
    await writeFile(join(setup.root, 'paper.tex'), 'ordinary source\n');
    await writeFile(join(setup.root, '.env'), 'TOKEN=synthetic\n');
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: [literalPath, 'paper.tex', '.env'],
    }));
    await service.command({ type: 'stage', projectId: 'p', path: literalPath });
    const names = await runTool(setup.git, [
      '-C',
      setup.root,
      'diff',
      '--cached',
      '--name-only',
      '-z',
    ]);
    expect(names.stdout).toBe(`${literalPath}\0`);
    expect(await service.command({ type: 'status', projectId: 'p' })).toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'paper.tex', index: '?' }),
        expect.objectContaining({ path: '.env', index: '?' }),
      ]),
    });
  });

  it('stages tracked files deleted from the live project inventory', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'main.tex'), 'baseline\n');
    for (const args of [
      ['-C', setup.root, 'add', '--', 'main.tex'],
      ['-C', setup.root, 'commit', '-qm', 'baseline'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    await rm(join(setup.root, 'main.tex'));
    const service = new GitService(() => ({ root: setup.root, projectId: 'p', paths: [] }));
    const diff = await service.command({
      type: 'diff',
      projectId: 'p',
      path: 'main.tex',
      area: 'worktree',
    });
    expect(diff).toMatchObject({ kind: 'diff', text: expect.stringContaining('baseline') });
    await service.command({ type: 'stage', projectId: 'p', path: 'main.tex' });
    expect(
      await runTool(setup.git, ['-C', setup.root, 'diff', '--cached', '--name-status']),
    ).toMatchObject({
      stdout: 'D\tmain.tex\n',
    });
  });

  it('normalizes repository-root paths for a project opened in a nested folder', async () => {
    const setup = await repository();
    if (!setup) return;
    const project = join(setup.root, 'paper');
    await mkdir(project);
    await writeFile(join(project, 'main.tex'), 'baseline\n');
    for (const args of [
      ['-C', setup.root, 'add', '--', 'paper/main.tex'],
      ['-C', setup.root, 'commit', '-qm', 'baseline'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    await writeFile(join(project, 'main.tex'), 'nested revision\n');
    const service = new GitService(() => ({ root: project, projectId: 'p', paths: ['main.tex'] }));
    const status = await service.command({ type: 'status', projectId: 'p' });
    expect(status).toMatchObject({
      kind: 'status',
      repositoryPrefix: `paper`,
      files: [expect.objectContaining({ path: 'main.tex', worktree: 'M' })],
    });
    expect(
      await service.command({ type: 'diff', projectId: 'p', path: 'main.tex', area: 'worktree' }),
    ).toMatchObject({ text: expect.stringContaining('nested revision') });
  });

  it('unstages newly staged paths in an unborn repository', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'main.tex'), 'still on disk\n');
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: ['main.tex'],
    }));
    await service.command({ type: 'stage', projectId: 'p', path: 'main.tex' });
    await service.command({ type: 'unstage', projectId: 'p', path: 'main.tex' });
    expect(await runTool(setup.git, ['-C', setup.root, 'status', '--porcelain'])).toMatchObject({
      stdout: '?? main.tex\n',
    });
  });

  it('exposes add/add conflicts and resolves a missing base stage without source loss', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'README'), 'base\n');
    for (const args of [
      ['-C', setup.root, 'add', '--', 'README'],
      ['-C', setup.root, 'commit', '-qm', 'base'],
      ['-C', setup.root, 'config', 'user.name', 'Loom Test'],
      ['-C', setup.root, 'config', 'user.email', 'loom@example.invalid'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    const mainBranch = await runTool(setup.git, ['-C', setup.root, 'branch', '--show-current']);
    expect(mainBranch.code).toBe(0);
    expect((await runTool(setup.git, ['-C', setup.root, 'branch', 'theirs'])).code).toBe(0);
    expect((await runTool(setup.git, ['-C', setup.root, 'switch', 'theirs'])).code).toBe(0);
    await writeFile(join(setup.root, 'new.tex'), 'theirs\n');
    expect((await runTool(setup.git, ['-C', setup.root, 'add', '--', 'new.tex'])).code).toBe(0);
    expect((await runTool(setup.git, ['-C', setup.root, 'commit', '-qm', 'theirs'])).code).toBe(0);
    expect(
      (await runTool(setup.git, ['-C', setup.root, 'switch', mainBranch.stdout.trim()])).code,
    ).toBe(0);
    await writeFile(join(setup.root, 'new.tex'), 'ours\n');
    expect((await runTool(setup.git, ['-C', setup.root, 'add', '--', 'new.tex'])).code).toBe(0);
    expect((await runTool(setup.git, ['-C', setup.root, 'commit', '-qm', 'ours'])).code).toBe(0);
    expect((await runTool(setup.git, ['-C', setup.root, 'merge', 'theirs'])).code).toBe(1);
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: ['README', 'new.tex'],
    }));
    const status = await service.command({ type: 'status', projectId: 'p' });
    expect(status).toMatchObject({
      kind: 'status',
      files: [
        expect.objectContaining({ path: 'new.tex', index: 'A', worktree: 'A', conflict: true }),
      ],
    });
    expect(
      await service.command({ type: 'diff', projectId: 'p', path: 'new.tex', area: 'base' }),
    ).toMatchObject({ text: expect.stringContaining('No base version') });
    await service.command({ type: 'resolve', projectId: 'p', path: 'new.tex', choice: 'ours' });
    expect(await runTool(setup.git, ['-C', setup.root, 'status', '--porcelain'])).toMatchObject({
      stdout: '',
    });
  });

  it('resolves a delete/modify conflict by choosing the side that deleted the file', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'main.tex'), 'base\n');
    for (const args of [
      ['-C', setup.root, 'add', '--', 'main.tex'],
      ['-C', setup.root, 'commit', '-qm', 'base'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    const mainBranch = await runTool(setup.git, ['-C', setup.root, 'branch', '--show-current']);
    expect((await runTool(setup.git, ['-C', setup.root, 'branch', 'deleted'])).code).toBe(0);
    expect((await runTool(setup.git, ['-C', setup.root, 'switch', 'deleted'])).code).toBe(0);
    await rm(join(setup.root, 'main.tex'));
    expect((await runTool(setup.git, ['-C', setup.root, 'commit', '-qam', 'delete'])).code).toBe(0);
    expect(
      (await runTool(setup.git, ['-C', setup.root, 'switch', mainBranch.stdout.trim()])).code,
    ).toBe(0);
    await writeFile(join(setup.root, 'main.tex'), 'modified\n');
    expect((await runTool(setup.git, ['-C', setup.root, 'commit', '-qam', 'modify'])).code).toBe(0);
    expect((await runTool(setup.git, ['-C', setup.root, 'merge', 'deleted'])).code).toBe(1);
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: ['main.tex'],
    }));
    expect(await service.command({ type: 'status', projectId: 'p' })).toMatchObject({
      kind: 'status',
      files: [expect.objectContaining({ path: 'main.tex', conflict: true })],
    });
    await service.command({ type: 'resolve', projectId: 'p', path: 'main.tex', choice: 'theirs' });
    await expect(readFile(join(setup.root, 'main.tex'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await runTool(setup.git, ['-C', setup.root, 'diff', '--cached', '--name-status']),
    ).toMatchObject({
      stdout: 'D\tmain.tex\n',
    });
  });

  it('rejects configured force and mirror pushes and can publish a new branch safely', async () => {
    const setup = await repository();
    if (!setup) return;
    const bare = join(setup.root, 'remote.git');
    const author = join(setup.root, 'author');
    await mkdir(author);
    await writeFile(join(author, 'main.tex'), 'baseline\n');
    for (const args of [
      ['-C', author, 'init', '-q', '-b', 'main'],
      ['-C', author, 'config', 'user.name', 'Loom Test'],
      ['-C', author, 'config', 'user.email', 'loom@example.invalid'],
      ['init', '--bare', '-q', bare],
      ['-C', author, 'add', '--', 'main.tex'],
      ['-C', author, 'commit', '-qm', 'baseline'],
      ['-C', author, 'remote', 'add', 'origin', bare],
      ['-C', author, 'push', '-qu', 'origin', 'HEAD'],
      ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    const partner = join(setup.root, 'partner');
    expect((await runTool(setup.git, ['clone', '-q', '--', bare, partner])).code).toBe(0);
    for (const args of [
      ['-C', partner, 'config', 'user.name', 'Loom Test'],
      ['-C', partner, 'config', 'user.email', 'loom@example.invalid'],
      ['-C', partner, 'fetch', 'origin'],
      ['-C', partner, 'switch', '-c', 'new-branch'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    const service = new GitService(() => ({ root: partner, projectId: 'p', paths: ['main.tex'] }));
    await service.command({ type: 'push', projectId: 'p', remote: 'origin' });
    expect(
      await runTool(setup.git, ['-C', partner, 'rev-parse', '--abbrev-ref', '@{upstream}']),
    ).toMatchObject({
      stdout: 'origin/new-branch\n',
    });
    const writer = join(setup.root, 'writer');
    expect((await runTool(setup.git, ['clone', '-q', '--', bare, writer])).code).toBe(0);
    for (const args of [
      ['-C', writer, 'config', 'user.name', 'Loom Test'],
      ['-C', writer, 'config', 'user.email', 'loom@example.invalid'],
      ['-C', writer, 'switch', '--track', 'origin/new-branch'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    await writeFile(join(writer, 'main.tex'), 'remote advance\n');
    expect(
      (await runTool(setup.git, ['-C', writer, 'commit', '-qam', 'remote advance'])).code,
    ).toBe(0);
    expect((await runTool(setup.git, ['-C', writer, 'push'])).code).toBe(0);
    await writeFile(join(partner, 'main.tex'), 'local divergence\n');
    expect(
      (await runTool(setup.git, ['-C', partner, 'commit', '-qam', 'local divergence'])).code,
    ).toBe(0);
    await runTool(setup.git, [
      '-C',
      partner,
      'config',
      'remote.origin.push',
      '+refs/heads/new-branch:refs/heads/new-branch',
    ]);
    await expect(service.command({ type: 'push', projectId: 'p' })).rejects.toThrow(
      /non-fast-forward|rejected/i,
    );
    await runTool(setup.git, ['-C', partner, 'config', 'remote.origin.mirror', 'true']);
    await expect(service.command({ type: 'push', projectId: 'p' })).rejects.toThrow(
      /mirror pushes/,
    );
  }, 120_000);

  it('reports when a Git hook changes the committed tree after index review', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'main.tex'), 'baseline\n');
    for (const args of [
      ['-C', setup.root, 'add', '--', 'main.tex'],
      ['-C', setup.root, 'commit', '-qm', 'baseline'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    const hooks = join(setup.root, 'hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nprintf "hook change\\n" > hook.txt\ngit add hook.txt\n');
    await chmod(hook, 0o755);
    for (const args of [
      ['-C', setup.root, 'config', 'core.hooksPath', hooks],
      ['-C', setup.root, 'config', 'user.name', 'Loom Test'],
      ['-C', setup.root, 'config', 'user.email', 'loom@example.invalid'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    await writeFile(join(setup.root, 'main.tex'), 'reviewed\n');
    const service = new GitService(() => ({
      root: setup.root,
      projectId: 'p',
      paths: ['main.tex', 'hook.txt'],
    }));
    await service.command({ type: 'stage', projectId: 'p', path: 'main.tex' });
    const status = await service.command({ type: 'status', projectId: 'p' });
    if (status.kind !== 'status' || !status.indexTree) throw new Error('Missing index tree.');
    const committed = await service.command({
      type: 'commit',
      projectId: 'p',
      message: 'reviewed',
      expectedIndexTree: status.indexTree,
    });
    expect(committed).toMatchObject({
      kind: 'status',
      commitNotice: expect.stringContaining('hook changed'),
    });
  });

  it('validates the entire staged path list even when it exceeds the ordinary tool-output buffer', async () => {
    const setup = await repository();
    if (!setup) return;
    await writeFile(join(setup.root, 'main.tex'), 'baseline\n');
    for (const args of [
      ['-C', setup.root, 'add', '--', 'main.tex'],
      ['-C', setup.root, 'commit', '-qm', 'baseline'],
    ])
      expect((await runTool(setup.git, args)).code).toBe(0);
    const paths = Array.from(
      { length: 1000 },
      (_, index) => `ordinary-${index}-${'x'.repeat(180)}.tex`,
    );
    for (const path of paths) await writeFile(join(setup.root, path), 'synthetic\n');
    await writeFile(join(setup.root, '.env'), 'TOKEN=synthetic\n');
    expect((await runTool(setup.git, ['-C', setup.root, 'add', '--all'])).code).toBe(0);
    const all = [...paths, '.env'];
    const service = new GitService(() => ({ root: setup.root, projectId: 'p', paths: all }));
    const status = await service.command({ type: 'status', projectId: 'p' });
    if (status.kind !== 'status' || !status.indexTree) throw new Error('Missing staged tree.');
    await expect(
      service.command({
        type: 'commit',
        projectId: 'p',
        message: 'large reviewed set',
        expectedIndexTree: status.indexTree,
      }),
    ).rejects.toThrow(/may be private/);
  });
});
