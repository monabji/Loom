import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter, object, dataList } from '../src/services/agents/opencode';
import { CodexAdapter } from '../src/services/agents/codex';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';
import { BuildService } from '../src/services/latex/builds';
import { AgentService } from '../src/services/agents/service';
const live = process.env.LOOM_AGENT_LIVE === '1';
it.skipIf(!live).each(['opencode', 'codex'] as const)(
  'connects actual %s, catalogs and project-bound sessions without inference',
  async (harness) => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-harness-live-'));
    let adapter: Awaited<ReturnType<typeof OpenCodeAdapter.owned>> | CodexAdapter | undefined;
    try {
      await writeFile(join(dir, 'main.tex'), 'Synthetic paper.');
      adapter =
        harness === 'opencode'
          ? await OpenCodeAdapter.owned(dir, process.env.LOOM_OPENCODE_EXECUTABLE)
          : await CodexAdapter.owned(dir, undefined, process.env.LOOM_CODEX_EXECUTABLE);
      expect(adapter.version).toMatch(/\d+\.\d+\.\d+/);
      expect((await adapter.models(dir)).length).toBeGreaterThan(0);
      const id = await adapter.create(dir);
      expect((await adapter.session(id)).location).toMatchObject({ directory: dir });
      expect(await adapter.pending(id)).toEqual({ permissions: [], questions: [] });
      expect(await adapter.messages(id)).toEqual([]);
      expect(await adapter.active(id)).toBe(false);
      if (adapter instanceof CodexAdapter) await adapter.resume(id, dir);
      else await adapter.stream();
    } finally {
      await adapter?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  40000,
);
it.skipIf(!live)(
  'connects actual OpenCode through AgentService with supported runtime MCP registration',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-agent-service-'));
    const root = join(dir, 'paper');
    await mkdir(root);
    await writeFile(join(root, 'main.tex'), 'Synthetic paper.');
    const store = new MetadataStore(join(dir, 'data'));
    const projects = new ProjectService(store);
    await projects.open(root);
    const builds = new BuildService(projects, join(dir, 'builds'));
    const agents = new AgentService(projects, builds, join(dir, 'data'));
    try {
      const id = projects.snapshot().id;
      const state = await agents.command({ type: 'connect', projectId: id, harness: 'opencode' });
      expect(state).toMatchObject({ connection: 'connected', toolsAvailable: true });
      const adapter = (agents as unknown as { adapter: OpenCodeAdapter }).adapter;
      const mcp = dataList(
        await adapter.request('GET', '/api/mcp?location[directory]=' + encodeURIComponent(root)),
      )
        .map(object)
        .find((m) => m.name === 'loom-paper');
      expect(mcp).toBeTruthy();
      expect(object(mcp!.status).type ?? object(mcp!.status).status).toBe('connected');
      const chat = await agents.command({ type: 'session', projectId: id });
      expect(chat.sessionId).toBeTruthy();
      expect(chat.sessions[0].harness).toBe('opencode');
      expect((await agents.command({ type: 'status', projectId: id })).connection).toBe(
        'connected',
      );
    } finally {
      await agents.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  40000,
);
it.skipIf(process.env.LOOM_AGENT_INFERENCE !== '1')(
  'actual OpenCode performs a synthetic revision and Loom safely reverts it',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-agent-inference-')),
      root = join(dir, 'paper');
    await mkdir(root);
    const original =
      '\\documentclass{article}\n\\begin{document}\nOriginal synthetic sentence.\n\\end{document}\n';
    await writeFile(join(root, 'main.tex'), original);
    const store = new MetadataStore(join(dir, 'data')),
      projects = new ProjectService(store);
    await projects.open(root);
    const builds = new BuildService(projects, join(dir, 'builds')),
      agents = new AgentService(projects, builds, join(dir, 'data'));
    try {
      const projectId = projects.snapshot().id;
      let state = await agents.command({
        type: 'connect',
        projectId,
        harness: 'opencode',
        executable: process.env.LOOM_OPENCODE_EXECUTABLE,
      });
      const model = state.models.find(
        (m) =>
          m.providerId === 'opencode' &&
          m.id === (process.env.LOOM_OPENCODE_MODEL ?? 'big-pickle') &&
          m.tools,
      );
      expect(model, 'configured tool-capable OpenCode model').toBeTruthy();
      state = await agents.command({ type: 'session', projectId });
      state = await agents.command({
        type: 'send',
        projectId,
        sessionId: state.sessionId!,
        prompt:
          'In main.tex replace exactly "Original synthetic sentence." with "A measured signal increases." using your file editing tool. Do not edit anything else or commit. Then report the changed filename.',
        model: model!,
        attachments: ['main.tex'],
        selection: null,
        revision: projects.snapshot().sourceRevision!,
      });
      const until = Date.now() + 120000;
      while (state.running && Date.now() < until) {
        for (const p of state.permissions)
          await agents.command({ type: 'permission', projectId, requestId: p.id, reply: 'once' });
        for (const q of state.questions)
          if (q.rejectable)
            await agents.command({
              type: 'answer',
              projectId,
              requestId: q.id,
              answer: Object.fromEntries(
                q.fields.map((f) => [f.key, f.type === 'boolean' ? true : 'yes']),
              ),
            });
        await new Promise((resolve) => setTimeout(resolve, 750));
        state = await agents.command({ type: 'status', projectId });
      }
      expect(state.error).toBe('');
      expect(state.running).toBe(false);
      expect(
        state.turns[0].status,
        state.messages
          .filter((m) => m.role === 'status' || m.role === 'assistant')
          .map((m) => m.text)
          .join('\n'),
      ).toBe('succeeded');
      expect(state.messages.some((m) => m.role === 'assistant')).toBe(true);
      expect(
        await (await import('node:fs/promises')).readFile(join(root, 'main.tex'), 'utf8'),
      ).toContain('A measured signal increases.');
      expect(state.turns[0].changes.some((c) => c.path === 'main.tex')).toBe(true);
      await agents.command({
        type: 'review',
        projectId,
        turnId: state.turns[0].id,
        path: 'main.tex',
        action: 'revert',
        revision: projects.snapshot().sourceRevision!,
      });
      expect(
        await (await import('node:fs/promises')).readFile(join(root, 'main.tex'), 'utf8'),
      ).toBe(original);
    } finally {
      await agents.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  150000,
);
it.skipIf(process.env.LOOM_CODEX_INFERENCE !== '1')(
  'actual Codex revises a synthetic paper, resumes it and retains safe review',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-codex-inference-')),
      root = join(dir, 'paper');
    await mkdir(root);
    const original = 'Original synthetic sentence.\n';
    await writeFile(join(root, 'main.tex'), original);
    const store = new MetadataStore(join(dir, 'data')),
      projects = new ProjectService(store);
    await projects.open(root);
    const agents = new AgentService(
      projects,
      new BuildService(projects, join(dir, 'builds')),
      join(dir, 'data'),
    );
    try {
      const projectId = projects.snapshot().id;
      let state = await agents.command({
        type: 'connect',
        projectId,
        harness: 'codex',
        executable: process.env.LOOM_CODEX_EXECUTABLE,
      });
      const model = state.models.find((m) => m.id.includes('luna')) ?? state.models[0];
      expect(model).toBeTruthy();
      state = await agents.command({ type: 'session', projectId });
      const sessionId = state.sessionId!;
      state = await agents.command({
        type: 'send',
        projectId,
        sessionId,
        prompt:
          'First call the Loom paper_structure MCP tool to inspect this paper. Then use your native filesystem tool to edit main.tex: replace exactly "Original synthetic sentence." with "Codex revised this synthetic sentence." Use a local file tool; preserve the newline. Do not edit other files or commit. Report the changed filename.',
        model,
        attachments: ['main.tex'],
        selection: null,
        revision: projects.snapshot().sourceRevision!,
      });
      const until = Date.now() + 120000;
      while (state.running && Date.now() < until) {
        for (const p of state.permissions)
          await agents.command({ type: 'permission', projectId, requestId: p.id, reply: 'once' });
        for (const q of state.questions)
          if (q.rejectable)
            await agents.command({
              type: 'answer',
              projectId,
              requestId: q.id,
              answer: Object.fromEntries(
                q.fields.map((f) => [f.key, f.type === 'boolean' ? true : 'yes']),
              ),
            });
        await new Promise((resolve) => setTimeout(resolve, 750));
        state = await agents.command({ type: 'status', projectId });
      }
      expect(state.error).toBe('');
      expect(state.running).toBe(false);
      expect(
        state.turns[0].status,
        state.messages
          .filter((m) => m.role === 'status' || m.role === 'assistant')
          .map((m) => m.text)
          .join('\n'),
      ).toBe('succeeded');
      expect(
        state.messages.some(
          (m) => m.role === 'tool' && m.text.includes('paper_structure') && m.state === 'completed',
        ),
        JSON.stringify(
          state.messages
            .filter((m) => m.role === 'tool')
            .map((m) => ({ text: m.text, state: m.state })),
        ),
      ).toBe(true);
      expect(
        await (await import('node:fs/promises')).readFile(join(root, 'main.tex'), 'utf8'),
      ).toContain('Codex revised');
      await agents.command({ type: 'disconnect', projectId });
      state = await agents.command({
        type: 'connect',
        projectId,
        harness: 'codex',
        executable: process.env.LOOM_CODEX_EXECUTABLE,
      });
      expect(state.sessionId).toBe(sessionId);
      expect(state.messages.some((m) => m.role === 'assistant')).toBe(true);
      await agents.command({
        type: 'review',
        projectId,
        turnId: state.turns[0].id,
        path: 'main.tex',
        action: 'revert',
        revision: projects.snapshot().sourceRevision!,
      });
      expect(
        await (await import('node:fs/promises')).readFile(join(root, 'main.tex'), 'utf8'),
      ).toBe(original);
    } finally {
      await agents.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  150000,
);
