import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../src/services/agents/service';
import { CodexAdapter } from '../src/services/agents/codex';
import { OpenCodeAdapter, type HarnessAdapter } from '../src/services/agents/opencode';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';
import { BuildService } from '../src/services/latex/builds';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'loom-reconnect-'));
  const root = join(directory, 'paper');
  await mkdir(root);
  await writeFile(join(root, 'main.tex'), 'Synthetic manuscript.');
  const store = new MetadataStore(join(directory, 'data'));
  const projects = new ProjectService(store);
  const project = await projects.open(root);
  const builds = new BuildService(projects, join(directory, 'builds'));
  const services: AgentService[] = [];
  const start = async () => {
    const agents = new AgentService(projects, builds, join(directory, 'data'));
    services.push(agents);
    await agents.initialize();
    return agents;
  };
  const adapter = {
    ownership: 'loom',
    version: '0.159.0',
    models: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    create: vi.fn(async () => 'native-chat'),
    session: vi.fn(async () => ({ location: { directory: root }, time: { idle: Date.now() } })),
    messages: vi.fn(async () => []),
    pending: vi.fn(async () => ({ permissions: [], questions: [] })),
    active: vi.fn(async () => false),
    send: vi.fn(),
    interrupt: vi.fn(),
  };
  const owned = vi
    .spyOn(CodexAdapter, 'owned')
    .mockImplementation(async () => adapter as unknown as CodexAdapter);
  return {
    start,
    project,
    store,
    adapter,
    owned,
    cleanup: async () => {
      for (const service of services) await service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('restores a connected provider and native chat after service reopen without resending work', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    await first.command({ type: 'connect', projectId: f.project.id, harness: 'codex' });
    const chat = await first.command({ type: 'session', projectId: f.project.id });
    await first.close();
    const reopened = await f.start();
    const state = await reopened.command({ type: 'status', projectId: f.project.id });
    expect(state.connection).toBe('connected');
    expect(state.sessionId).toBe(chat.sessionId);
    expect(f.owned).toHaveBeenCalledTimes(2);
    expect(f.adapter.create).toHaveBeenCalledTimes(1);
    expect(f.adapter.send).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it('honors explicit Disconnect across reopen', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    await first.command({ type: 'connect', projectId: f.project.id, harness: 'codex' });
    await first.command({ type: 'disconnect', projectId: f.project.id });
    await first.close();
    const reopened = await f.start();
    expect((await reopened.command({ type: 'status', projectId: f.project.id })).connection).toBe(
      'disconnected',
    );
    expect(f.owned).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});

it('retains a failed restoration as actionable state and does not retry on every status poll', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    await first.command({ type: 'connect', projectId: f.project.id, harness: 'codex' });
    await first.close();
    f.owned.mockRejectedValueOnce(new Error('Synthetic missing runtime'));
    const reopened = await f.start();
    const state = await reopened.command({ type: 'status', projectId: f.project.id });
    expect(state.error).toContain('Could not reconnect Codex');
    await reopened.command({ type: 'status', projectId: f.project.id });
    expect(f.owned).toHaveBeenCalledTimes(2);
    expect(f.adapter.send).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it('does not retain external server credentials or reconnect an attached server on reopen', async () => {
  const f = await fixture();
  try {
    vi.spyOn(OpenCodeAdapter, 'attach').mockResolvedValue({
      ...f.adapter,
      ownership: 'external',
    } as unknown as HarnessAdapter as OpenCodeAdapter);
    const first = await f.start();
    await first.command({
      type: 'connect',
      projectId: f.project.id,
      harness: 'opencode',
      endpoint: 'http://127.0.0.1:4096',
      password: 'synthetic-secret',
    });
    await first.close();
    const reopened = await f.start();
    expect((await reopened.command({ type: 'status', projectId: f.project.id })).connection).toBe(
      'disconnected',
    );
    expect(OpenCodeAdapter.attach).toHaveBeenCalledTimes(1);
    expect(f.store.get(`agent-reconnect:${f.project.id}`) ?? '').not.toContain('synthetic-secret');
  } finally {
    await f.cleanup();
  }
});

it('keeps native conversation permissions and reasoning during restoration', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    await first.command({ type: 'connect', projectId: f.project.id, harness: 'codex' });
    const chat = await first.command({ type: 'session', projectId: f.project.id });
    await first.command({
      type: 'settings',
      projectId: f.project.id,
      settings: { permissionMode: 'supervised', reasoning: 'low' },
    });
    await first.close();
    const reopened = await f.start();
    const state = await reopened.command({ type: 'status', projectId: f.project.id });
    expect(state.sessionId).toBe(chat.sessionId);
    expect(state.settings).toEqual({ permissionMode: 'supervised', reasoning: 'low' });
    expect(f.adapter.send).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it('leaves legacy ownership ambiguous and rejects unknown reconnect metadata without launching', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    expect((await first.command({ type: 'status', projectId: f.project.id })).connection).toBe(
      'disconnected',
    );
    expect(f.owned).not.toHaveBeenCalled();
    await first.close();
    f.store.set(
      `agent-reconnect:${f.project.id}`,
      JSON.stringify({ version: 99, harness: 'codex' }),
    );
    const reopened = await f.start();
    const state = await reopened.command({ type: 'status', projectId: f.project.id });
    expect(state.connection).toBe('disconnected');
    expect(state.error).toContain('compatible Loom version');
    expect(f.owned).not.toHaveBeenCalled();
    expect(JSON.parse(f.store.get(`agent-reconnect:${f.project.id}`)!).version).toBe(99);
  } finally {
    await f.cleanup();
  }
}, 15000);
