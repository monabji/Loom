import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';
import { BuildService } from '../src/services/latex/builds';
import { AgentTools } from '../src/services/agents/tools';
import { createTestSymlink } from './helpers/symlink';
import { AgentChanges } from '../src/services/agents/changes';

it('runs authenticated file organization through a saved checkpoint and preserves root identity and recoverable deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-paper-tools-'));
  const root = join(dir, 'paper');
  await mkdir(root);
  await writeFile(
    join(root, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}Synthetic.\\end{document}\n',
  );
  const store = new MetadataStore(join(dir, 'data'));
  const projects = new ProjectService(store);
  const project = await projects.open(root);
  const changes = new AgentChanges(projects, join(dir, 'recovery'));
  await changes.bind(project.id);
  let active = false,
    saves = 0;
  const tools = await new AgentTools(
    projects,
    new BuildService(projects, join(dir, 'builds')),
    project.id,
    {
      canMutate: () => active,
      save: async () => {
        saves++;
        return projects.snapshot().sourceRevision!;
      },
    },
  ).start();
  const call = async (name: string, args: unknown = {}) => {
    const response = await fetch(tools.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tools.token },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return (await response.json()).result;
  };
  try {
    expect((await call('paper_delete_file', { path: 'main.tex' })).isError).toBe(true);
    const turn = await projects.run(() =>
      changes.begin('native-session', projects.snapshot().sourceRevision!, false, process.pid),
    );
    active = true;
    const list = JSON.parse((await call('paper_files')).content[0].text);
    expect(list.mainDocument).toBe('main.tex');
    const created = await call('paper_create_file', {
      path: 'sections/methods.tex',
      text: '\\section{Methods}\nSynthetic methods.\n',
    });
    expect(created.isError).toBeUndefined();
    expect(await readFile(join(root, 'sections/methods.tex'), 'utf8')).toContain(
      'Synthetic methods.',
    );
    expect((await call('paper_create_file', { path: 'main.tex', text: 'Overwrite' })).isError).toBe(
      true,
    );
    const moved = await call('paper_move_file', {
      path: 'main.tex',
      destination: 'manuscript/paper.tex',
    });
    expect(moved.isError).toBeUndefined();
    expect(projects.snapshot().rootId).toBe(project.rootId);
    expect(JSON.parse(await readFile(join(root, 'loom.build.json'), 'utf8')).root).toBe(
      'manuscript/paper.tex',
    );
    await projects.refresh();
    expect(
      projects.snapshot().files.find((file) => file.id === projects.snapshot().rootId)?.path,
    ).toBe('manuscript/paper.tex');
    await call('paper_create_file', {
      path: 'alternate.tex',
      text: '\\documentclass{article}\nAlternative.',
    });
    const assigned = await call('paper_set_main', { path: 'alternate.tex' });
    expect(JSON.parse(assigned.content[0].text).mainDocument).toBe('alternate.tex');
    await call('paper_delete_file', { path: 'sections/methods.tex' });
    await expect(readFile(join(root, 'sections/methods.tex'))).rejects.toThrow();
    expect(
      projects.snapshot().files.find((file) => file.path === 'sections/methods.tex')?.deleted,
    ).toBe(true);
    await projects.run(() => changes.finish('succeeded'));
    expect(
      changes
        .views()
        .find((entry) => entry.id === turn.view.id)
        ?.changes.map((change) => change.path),
    ).toContain('loom.build.json');
    const rootChange = changes.views()[0].changes.find((change) => change.path === 'main.tex');
    expect(rootChange?.humanTouched).toBe(false);
    expect(saves).toBeGreaterThan(3);
    expect(
      (await readdir(join(root, 'manuscript'))).some((path) => path.startsWith('.loom-save-')),
    ).toBe(false);
    await writeFile(join(dir, 'outside.tex'), 'Outside data.');
    const hasSymlink = await createTestSymlink(join(dir, 'outside.tex'), join(root, 'link.tex'));
    for (const path of ['../outside.tex', '.git/config', ...(hasSymlink ? ['link.tex'] : [])])
      expect((await call('paper_delete_file', { path })).isError).toBe(true);
    expect(await readFile(join(dir, 'outside.tex'), 'utf8')).toBe('Outside data.');
  } finally {
    await tools.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
