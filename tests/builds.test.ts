import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectService } from '../src/services/project/projects';
import { MetadataStore } from '../src/services/project/store';
import { BuildService } from '../src/services/latex/builds';
import { compilerDiagnostics } from '../src/services/latex/diagnostics';
import { latexCommandSchema } from '../src/contracts/latex';
import * as tools from '../src/services/latex/tools';
import { toolNames } from '../src/contracts/latex';
import { projectStructure } from '../src/services/latex/language';
let directory: string, projects: ProjectService, builds: BuildService, store: MetadataStore;
beforeEach(async () => {
  vi.spyOn(tools, 'detectTools').mockResolvedValue([]);
  directory = await mkdtemp(join(tmpdir(), 'loom-build-'));
  const root = join(directory, 'paper with spaces');
  await mkdir(root);
  await mkdir(join(root, 'sections'));
  await writeFile(
    join(root, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\n\\input{sections/body}\n\\end{document}\n',
  );
  await writeFile(
    join(root, 'sections/body.tex'),
    '\\section{First}\\label{sec:first}\nHello snapshot.\n',
  );
  store = new MetadataStore(join(directory, 'data'));
  projects = new ProjectService(store);
  await projects.open(root);
  builds = new BuildService(projects, join(directory, 'cache'));
});
afterEach(async () => {
  builds.dispose();
  await builds.idle(projects.snapshot().id);
  store.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
function fakeTools() {
  vi.mocked(tools.detectTools).mockResolvedValue(
    toolNames.map((name) => ({
      name,
      executable: name,
      available: true,
      version: 'synthetic tool 1',
    })),
  );
  vi.spyOn(tools, 'runTool').mockImplementation(async (_executable, args, options) => {
    const cwd = options?.cwd;
    const out = args.find((arg) => arg.startsWith('-outdir='))?.slice(8);
    if (!cwd || !out) throw new Error('Missing synthetic compiler input or output directory.');
    const input = await readFile(join(cwd, 'sections/body.tex'), 'utf8');
    if (input.includes('FAIL')) {
      const stderr = 'sections/body.tex:2: Undefined control sequence.';
      options.onOutput?.(stderr);
      return { code: 1, output: stderr, stdout: '', stderr };
    }
    await new Promise((resolve) => setTimeout(resolve, input.includes('SLOW') ? 500 : 50));
    if (options.signal?.aborted) return { code: 130, output: '', stdout: '', stderr: '' };
    await writeFile(join(out, 'main.pdf'), '%PDF-1.7\n' + input);
    if (!input.includes('NO_MAP'))
      await writeFile(join(out, 'main.synctex.gz'), 'synthetic mapping');
    const stdout = 'synthetic successful run';
    options.onOutput?.(stdout);
    return { code: 0, output: stdout, stdout, stderr: '' };
  });
}
describe('snapshot build scheduler (synthetic compiler)', () => {
  it('keeps a stable snapshot, includes binary inputs in freshness and retains success on failure', async () => {
    fakeTools();
    const id = projects.snapshot().id;
    await writeFile(join(directory, 'paper with spaces', 'asset.bin'), Buffer.from([0, 1, 2]));
    await projects.refresh();
    builds.request(id, false);
    await builds.idle(id);
    const first = await builds.status(id);
    expect(first.current?.status).toBe('succeeded');
    const artifact = builds.artifact(id, first.successful!.id);
    expect(await readFile(join(artifact.source, 'sections/body.tex'), 'utf8')).toContain(
      'Hello snapshot',
    );
    expect(first.successful!.revision).toBe(projects.snapshot().sourceRevision);
    await writeFile(join(directory, 'paper with spaces', 'asset.bin'), Buffer.from([0, 3, 2]));
    await projects.refresh();
    expect(first.successful!.revision).not.toBe(projects.snapshot().sourceRevision);
    await writeFile(join(directory, 'paper with spaces', 'sections/body.tex'), 'FAIL');
    await projects.refresh();
    builds.request(id, true);
    await builds.idle(id);
    const failed = await builds.status(id);
    expect(failed.current?.status).toBe('failed');
    expect(failed.current?.diagnostics[0].path).toBe('sections/body.tex');
    expect(failed.successful?.id).toBe(first.successful?.id);
    expect((await builds.pdf(id, first.successful!.id)).kind).toBe('pdf');
    expect(await readFile(join(artifact.source, 'asset.bin'))).toEqual(Buffer.from([0, 1, 2]));
    const reopened = new BuildService(projects, join(directory, 'cache'));
    expect((await reopened.status(id)).successful?.id).toBe(first.successful?.id);
  });
  it('coalesces pending requests, saves continue during compilation, cancellation drops pending intent', async () => {
    fakeTools();
    const id = projects.snapshot().id;
    await writeFile(join(directory, 'paper with spaces', 'sections/body.tex'), 'SLOW');
    await projects.refresh();
    const first = builds.request(id, false).current!.id;
    await new Promise((r) => setTimeout(r, 150));
    expect((await projects.command({ type: 'refresh' }))?.id).toBe(id);
    expect(builds.request(id, false).queued).toBe(true);
    builds.request(id, true);
    await builds.idle(id);
    await builds.idle(id);
    const next = await builds.status(id);
    expect(next.current!.id).not.toBe(first);
    expect(next.current!.status).toBe('succeeded');
    builds.request(id, false);
    builds.request(id, true);
    builds.cancel(id);
    await builds.idle(id);
    const cancelled = await builds.status(id);
    expect(cancelled.current?.status).toBe('cancelled');
    expect(cancelled.queued).toBe(false);
    expect(cancelled.successful).not.toBeNull();
  });
  it('records a queued build failure if the selected root is deleted during compilation', async () => {
    fakeTools();
    const id = projects.snapshot().id;
    await writeFile(join(directory, 'paper with spaces', 'sections/body.tex'), 'SLOW');
    await projects.refresh();
    builds.request(id, false);
    await new Promise((r) => setTimeout(r, 150));
    builds.request(id, false);
    await projects.command({ type: 'delete', fileId: projects.snapshot().rootId! });
    await builds.idle(id);
    expect((await builds.status(id)).current?.status).toBe('failed');
    expect((await builds.status(id)).current?.log).toContain('root');
  });
  it('rejects mismatched bibliography choices and writes portable settings only explicitly', async () => {
    fakeTools();
    const id = projects.snapshot().id;
    await expect(
      readFile(join(directory, 'paper with spaces', 'loom.build.json')),
    ).rejects.toThrow();
    await builds.settings(id, {
      engine: 'xelatex',
      bibliography: 'bibtex',
      recipe: 'latexmk',
      autoBuild: false,
      delayMs: 1000,
    });
    const config = JSON.parse(
      await readFile(join(directory, 'paper with spaces', 'loom.build.json'), 'utf8'),
    );
    expect(config.root).toBe('main.tex');
    expect(config.settings.engine).toBe('xelatex');
    expect(JSON.stringify(config)).not.toContain(directory);
    await writeFile(
      join(directory, 'paper with spaces', 'main.tex'),
      '\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n',
    );
    await projects.refresh();
    builds.request(id, false);
    await builds.idle(id);
    expect((await builds.status(id)).current?.log).toContain('Select Biber');
    const copiedRoot = join(directory, 'copied');
    const { cp } = await import('node:fs/promises');
    await cp(join(directory, 'paper with spaces'), copiedRoot, { recursive: true });
    const secondStore = new MetadataStore(join(directory, 'copied-data'));
    const second = new ProjectService(secondStore);
    await second.open(copiedRoot);
    expect(second.buildContext(second.snapshot().id).settings?.engine).toBe('xelatex');
    secondStore.close();
  });
  it('reloads external portable root/settings and rejects malformed configuration before building', async () => {
    fakeTools();
    const id = projects.snapshot().id;
    await builds.settings(id, {
      engine: 'pdflatex',
      bibliography: 'auto',
      recipe: 'latexmk',
      autoBuild: false,
      delayMs: 1500,
    });
    await writeFile(
      join(directory, 'paper with spaces', 'alternate.tex'),
      '\\documentclass{article}\n\\begin{document}Alternate\\end{document}',
    );
    const config = {
      version: 1,
      root: 'alternate.tex',
      settings: {
        engine: 'lualatex',
        bibliography: 'none',
        recipe: 'latexmk',
        autoBuild: false,
        delayMs: 1000,
      },
    };
    await writeFile(
      join(directory, 'paper with spaces', 'loom.build.json'),
      JSON.stringify(config),
    );
    await projects.refresh();
    expect((await builds.status(id)).settings.engine).toBe('lualatex');
    expect(projects.snapshot().files.find((f) => f.id === projects.snapshot().rootId)?.path).toBe(
      'alternate.tex',
    );
    await writeFile(join(directory, 'paper with spaces', 'loom.build.json'), '{invalid');
    await projects.refresh();
    builds.request(id, false);
    await builds.idle(id);
    expect((await builds.status(id)).current?.log).toContain('loom.build.json');
    await writeFile(
      join(directory, 'paper with spaces', 'loom.build.json'),
      JSON.stringify(config),
    );
    await projects.refresh();
    expect(projects.buildContext(id).configError).toBeUndefined();
    await writeFile(join(directory, 'paper with spaces', 'loom.build.json'), '{invalid');
    await projects.refresh();
    await builds.settings(id, {
      engine: 'xelatex',
      bibliography: 'auto',
      recipe: 'latexmk',
      autoBuild: false,
      delayMs: 1500,
    });
    expect(
      JSON.parse(await readFile(join(directory, 'paper with spaces', 'loom.build.json'), 'utf8'))
        .settings.engine,
    ).toBe('xelatex');
    expect(projects.buildContext(id).configError).toBeUndefined();
    await projects.command({
      type: 'rename',
      fileId: projects.snapshot().rootId!,
      path: 'renamed.tex',
    });
    await projects.refresh();
    expect(projects.buildContext(id).configError).toContain('missing-root');
    await builds.settings(id, {
      engine: 'xelatex',
      bibliography: 'auto',
      recipe: 'latexmk',
      autoBuild: false,
      delayMs: 1500,
    });
    expect(
      JSON.parse(await readFile(join(directory, 'paper with spaces', 'loom.build.json'), 'utf8'))
        .root,
    ).toBe('renamed.tex');
    expect(projects.buildContext(id).configError).toBeUndefined();
    await projects.command({ type: 'delete', fileId: projects.snapshot().rootId! });
    await projects.refresh();
    expect(projects.buildContext(id).configError).toContain('missing-root');
  });
  it('provides an explicit fallback when a successful output has no source map', async () => {
    fakeTools();
    const id = projects.snapshot().id;
    await writeFile(join(directory, 'paper with spaces', 'sections/body.tex'), 'NO_MAP');
    await projects.refresh();
    builds.request(id, false);
    await builds.idle(id);
    const state = await builds.status(id);
    expect(state.successful?.hasPdf).toBe(true);
    expect(state.successful?.hasSynctex).toBe(false);
    await expect(
      builds.mapping({
        type: 'forward',
        projectId: id,
        buildId: state.successful!.id,
        path: 'main.tex',
        line: 1,
      }),
    ).rejects.toThrow('no SyncTeX mapping');
  });
  it('recovers a missing-tool build after installation without restarting the service', async () => {
    const id = projects.snapshot().id;
    builds.request(id, false);
    await builds.idle(id);
    expect((await builds.status(id)).current?.log).toContain('Missing tools:');
    fakeTools();
    builds.request(id, false);
    await builds.idle(id);
    expect((await builds.status(id)).successful).not.toBeNull();
  });
  it('reports missing tools and ambiguous roots without modifying the project', async () => {
    const id = projects.snapshot().id;
    builds.request(id, false);
    await builds.idle(id);
    expect((await builds.status(id)).current?.log).toContain('Missing tools:');
    await writeFile(join(directory, 'paper with spaces', 'other.tex'), '\\documentclass{article}');
    const another = new ProjectService(store);
    await another.open(join(directory, 'paper with spaces'));
    // The established root is retained; new ambiguous projects require explicit root selection.
    const ambiguous = join(directory, 'ambiguous');
    await mkdir(ambiguous);
    await writeFile(join(ambiguous, 'a.tex'), '\\documentclass{article}');
    await writeFile(join(ambiguous, 'b.tex'), '\\documentclass{article}');
    await projects.open(ambiguous);
    expect(projects.snapshot().rootId).toBeNull();
    expect(() => builds.request(projects.snapshot().id, false)).toThrow('root');
  });
  it('refuses conflicts, rejects cross-project artifact access and exposes literal structure', async () => {
    fakeTools();
    const id = projects.snapshot().id;
    expect(projectStructure(projects.buildContext(id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'label', title: 'sec:first', path: 'sections/body.tex' }),
      ]),
    );
    expect(() => builds.artifact('other', 'build')).toThrow('project changed');
    await rm(join(directory, 'paper with spaces', 'main.tex'));
    await projects.refresh();
    builds.request(id, false);
    await builds.idle(id);
    expect((await builds.status(id)).current?.log).toContain('conflicts');
  });
});
it('validates only named commands and maps logs without escaping snapshot paths', () => {
  expect(
    latexCommandSchema.safeParse({ type: 'build', projectId: 'x', clean: false, shell: 'bad' })
      .success,
  ).toBe(false);
  expect(
    latexCommandSchema.safeParse({
      type: 'forward',
      projectId: 'x',
      buildId: 'b',
      path: '../secret',
      line: 1,
    }).success,
  ).toBe(false);
  expect(
    compilerDiagnostics(
      '/cache/source/sections/body.tex:3: Bad command\n/etc/private.tex:4: secret',
      '/cache/source',
      ['sections/body.tex'],
    ).map((d) => d.path),
  ).toEqual(['sections/body.tex', null]);
});
it('terminates an actual native process group on cancellation', async () => {
  const abort = new AbortController();
  const result = tools.runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 100);
  expect((await result).code).not.toBe(0);
});

it('keeps package and LaTeX warnings separate from actual compiler errors', () => {
  const diagnostics = compilerDiagnostics(
    [
      'Package epstopdf Warning: Shell escape feature is not enabled.',
      'LaTeX Warning: Reference `missing` undefined.',
      './main.tex:7: Undefined control sequence.',
    ].join('\n'),
    '/paper',
    ['main.tex'],
  );
  expect(diagnostics.map((item) => item.severity)).toEqual(['warning', 'warning', 'error']);
});
