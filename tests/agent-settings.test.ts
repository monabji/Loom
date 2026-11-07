import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentState } from '../src/contracts/agent';
import { AgentService } from '../src/services/agents/service';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';
import { BuildService } from '../src/services/latex/builds';

it('preserves the selected chat settings and blocks sends when its native session belongs to another folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-settings-'));
  const root = join(dir, 'paper');
  await mkdir(root);
  await writeFile(join(root, 'main.tex'), 'Synthetic manuscript.');
  const store = new MetadataStore(join(dir, 'data'));
  const projects = new ProjectService(store);
  const project = await projects.open(root);
  const agents = new AgentService(
    projects,
    new BuildService(projects, join(dir, 'builds')),
    join(dir, 'data'),
  );
  await agents.initialize();
  const internal = agents as unknown as {
    state: AgentState;
    sessions: AgentState['sessions'];
    adapter: unknown;
  };
  internal.state.connection = 'connected';
  internal.state.sessionId = 'current';
  internal.state.settings = { permissionMode: 'supervised', reasoning: 'low' };
  internal.sessions.push({
    id: 'target',
    harness: 'opencode',
    title: 'Different paper',
    settings: { permissionMode: 'full-access', reasoning: 'high' },
  });
  internal.adapter = {
    session: async () => ({ location: { directory: join(dir, 'other-paper') } }),
    close: async () => {},
  };
  try {
    const selected = await agents.command({
      type: 'session',
      projectId: project.id,
      sessionId: 'target',
    });
    expect(selected.sessionId).toBe('target');
    expect(selected.settings).toEqual({ permissionMode: 'full-access', reasoning: 'high' });
    expect(selected).toMatchObject({
      sessionUnavailable: true,
      restore: { reason: 'folder-mismatch' },
    });
    expect(
      JSON.parse(store.get(`agent-sessions:${project.id}`)!).sessions[0].nativeSessions.opencode,
    ).toBe('target');
    await expect(
      agents.command({
        type: 'send',
        projectId: project.id,
        sessionId: 'target',
        prompt: 'Change the paper',
        model: { id: 'm', providerId: 'p', name: 'M', images: false, tools: true },
        attachments: [],
        selection: null,
        revision: 'revision',
      }),
    ).rejects.toThrow('Restore this conversation');
  } finally {
    await agents.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
