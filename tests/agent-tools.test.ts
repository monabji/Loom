import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';
import { BuildService } from '../src/services/latex/builds';
import { AgentTools } from '../src/services/agents/tools';
it('exposes authenticated bounded project/build MCP tools without a model execution loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-mcp-')),
    root = join(dir, 'paper');
  await mkdir(root);
  await writeFile(
    join(root, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\n\\section{Synthetic section}\nSynthetic content.\n\\end{document}\n',
  );
  const store = new MetadataStore(join(dir, 'data')),
    projects = new ProjectService(store);
  await projects.open(root);
  const projectId = projects.snapshot().id,
    builds = new BuildService(projects, join(dir, 'builds')),
    tools = await new AgentTools(projects, builds, projectId).start();
  try {
    expect((await fetch(tools.url)).status).toBe(401);
    const call = async (method: string, params?: unknown) => {
      const response = await fetch(tools.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tools.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: response.status, data: await response.json() };
    };
    expect(
      (await call('initialize', { protocolVersion: '2024-11-05' })).data.result.capabilities,
    ).toEqual({ tools: {} });
    const names = (await call('tools/list')).data.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'paper_structure',
      'paper_diagnostics',
      'pdf_status',
      'paper_files',
      'paper_save',
      'paper_create_file',
      'paper_move_file',
      'paper_delete_file',
      'paper_set_main',
      'build_pdf',
    ]);
    const structure = (await call('tools/call', { name: 'paper_structure', arguments: {} })).data
      .result.content[0].text;
    expect(structure).toContain('Synthetic section');
    const withMetadata = await call('tools/call', {
      name: 'paper_structure',
      arguments: {},
      _meta: { progressToken: 1 },
    });
    expect(withMetadata.data.result.isError).not.toBe(true);
    expect(withMetadata.data.result.content[0].text).toContain('Synthetic section');
    expect((await call('tools/call', { name: 'pdf_status', arguments: {} })).status).toBe(200);
    const errors = await call('tools/call', { name: 'paper_diagnostics', arguments: {} });
    expect(errors.data.result.isError).not.toBe(true);
    expect(JSON.parse(errors.data.result.content[0].text)).toMatchObject({
      build: null,
      buildStatusAvailable: true,
    });
    const bad = await call('tools/call', {
      name: 'build_pdf',
      arguments: { path: '../secret' },
      _meta: { progressToken: 2 },
    });
    expect(bad.status).toBe(200);
    expect(bad.data.result.isError).toBe(true);
    expect(bad.data.result.content[0].text).toContain('arguments');
    if (process.env.LOOM_LATEX_LIVE === '1') {
      const response = await call('tools/call', { name: 'build_pdf', arguments: {} });
      expect(response.status).toBe(200);
      const until = Date.now() + 30000;
      let state = await builds.status(projectId);
      while ((state.current?.status === 'running' || state.queued) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        state = await builds.status(projectId);
      }
      expect(state.current?.status).toBe('succeeded');
      expect(state.successful?.revision).toBe(projects.snapshot().sourceRevision);
      expect(state.successful?.hasPdf).toBe(true);
    }
  } finally {
    await tools.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 40000);
