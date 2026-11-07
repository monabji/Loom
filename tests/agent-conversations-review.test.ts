import { describe, expect, it, vi } from 'vitest';
import { AgentService } from '../src/services/agents/service';

type Internal = {
  adapter: object | null;
  state: Record<string, unknown>;
  sessions: unknown[];
  connections: Map<string, { adapter: object; tools: object; interrupted: boolean }>;
  generation: number;
  refreshBusy: boolean;
  changes: object;
  refresh(): Promise<void>;
  resumeCurrent(): Promise<void>;
  discardInterrupted(kind: string): Promise<void>;
  ensureNative(id: string): Promise<string>;
  resume(id: string): Promise<void>;
};
function make() {
  const service = Object.create(AgentService.prototype) as Internal;
  const adapter = {
    messages: vi.fn(async () => {
      throw new Error('transport lost');
    }),
    pending: vi.fn(async () => ({ permissions: [], questions: [] })),
    active: vi.fn(async () => false),
    close: vi.fn(async () => {}),
  };
  const tools = { close: vi.fn(async () => {}) };
  const connection = { adapter, tools, interrupted: false };
  const state = {
    harness: 'opencode',
    sessionId: 'chat',
    connection: 'connected',
    running: false,
    messages: [{ id: 'public', text: 'Retain me' }],
    permissions: [],
    questions: [],
    providers: [{ id: 'opencode', connected: true }],
    error: '',
  };
  Object.assign(service, {
    adapter,
    state,
    sessions: [],
    connections: new Map([['opencode', connection]]),
    generation: 0,
    refreshBusy: false,
    changes: { unsettledExternal: () => undefined, linkSubmittedAttachments: vi.fn() },
  });
  return { service, adapter, tools, connection, state };
}
describe('conversation connection recovery', () => {
  it('keeps the pooled transport usable after a transient status read fails', async () => {
    const { service, connection, state } = make();
    await service.refresh();
    expect(connection.interrupted).toBe(false);
    expect(state.connection).toBe('connected');
    expect(state.providers[0].connected).toBe(true);
    expect(state.error).toContain('Could not refresh agent status');
  });
  it('retains a saved transcript and marks it unavailable if native resume fails', async () => {
    const { service, state } = make();
    service.ensureNative = vi.fn(async () => 'native');
    service.resume = vi.fn(async () => {
      throw new Error('missing native session');
    });
    await service.resumeCurrent();
    expect(state).toMatchObject({
      sessionId: 'chat',
      sessionUnavailable: true,
      messages: [{ text: 'Retain me' }],
    });
    expect(state).toMatchObject({ restore: { sessionId: 'chat', reason: 'retryable' } });
    expect(state.error).toContain('retry');
    service.resume = vi.fn(async () => {});
    await service.resumeCurrent();
    expect(state).toMatchObject({ sessionId: 'chat', sessionUnavailable: false });
  });
  it('closes an inactive interrupted connection and its MCP server before replacement', async () => {
    const { service, adapter, tools, connection } = make();
    service.adapter = {};
    connection.interrupted = true;
    await service.discardInterrupted('opencode');
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(tools.close).toHaveBeenCalledOnce();
    expect(service.connections.has('opencode')).toBe(false);
  });
});

it('switches pooled providers without changing the Loom conversation or mixing native IDs and settings', async () => {
  const { service } = make();
  const calls: string[] = [];
  const model = { id: 'm', providerId: 'p', name: 'model', images: false, tools: true };
  const makeAdapter = (name: string) => ({
    version: 'test',
    ownership: 'loom',
    session: vi.fn(async (id: string) => {
      calls.push(`${name}:${id}`);
      return { location: { directory: '/paper' } };
    }),
    active: vi.fn(async () => false),
    messages: vi.fn(async () => [
      { id: 'same-message', role: 'assistant', text: `${name} response`, state: '' },
    ]),
    pending: vi.fn(async () => ({ permissions: [], questions: [] })),
  });
  const opencode = makeAdapter('opencode');
  const codex = makeAdapter('codex');
  const opSettings = { permissionMode: 'supervised', reasoning: 'low' };
  const coSettings = { permissionMode: 'full-access', reasoning: 'high' };
  const ref = {
    id: 'chat',
    title: 'Chat',
    harness: 'opencode',
    nativeSessions: { opencode: 'same-native', codex: 'same-native' },
    nativeSettings: { opencode: opSettings, codex: coSettings },
    history: [],
  };
  const state: Record<string, unknown> = {
    ...service.state,
    sessionUnavailable: false,
    settings: opSettings,
    models: [model],
  };
  Object.assign(service, {
    adapter: opencode,
    state,
    sessions: [ref],
    projectId: 'paper',
    persisted: '',
    connections: new Map([
      ['opencode', { adapter: opencode, tools: {}, models: [model], interrupted: false }],
      ['codex', { adapter: codex, tools: {}, models: [model], interrupted: false }],
    ]),
    changes: { unsettledExternal: () => undefined, linkSubmittedAttachments: vi.fn() },
    projects: {
      run: async (f: () => unknown) => f(),
      buildContext: () => ({ root: '/paper' }),
      store: { set: vi.fn() },
    },
  });
  const internal = service as Internal & { activate(kind: string): Promise<void> };
  await internal.activate('opencode');
  await service.resumeCurrent();
  await internal.activate('codex');
  await service.resumeCurrent();
  expect(state).toMatchObject({
    sessionId: 'chat',
    harness: 'codex',
    settings: coSettings,
    sessionUnavailable: false,
  });
  expect(state.messages).toMatchObject([
    { harness: 'opencode', text: 'opencode response' },
    { harness: 'codex', text: 'codex response' },
  ]);
  expect(new Set((state.messages as { id: string }[]).map((message) => message.id)).size).toBe(2);
  await internal.activate('opencode');
  await service.resumeCurrent();
  expect(state.settings).toEqual(opSettings);
  expect(calls).toEqual(['opencode:same-native', 'codex:same-native', 'opencode:same-native']);
});

it.skipIf(process.env.LOOM_LATEX_LIVE !== '1')(
  'schedules a real post-edit build without blocking the project queue',
  async () => {
    const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { MetadataStore } = await import('../src/services/project/store');
    const { ProjectService } = await import('../src/services/project/projects');
    const { BuildService } = await import('../src/services/latex/builds');
    const dir = await mkdtemp(join(tmpdir(), 'loom-agent-autobuild-'));
    const root = join(dir, 'paper');
    await mkdir(root);
    const source = join(root, 'main.tex');
    const initial = '\\documentclass{article}\n\\begin{document}\nInitial.\n\\end{document}\n';
    const revised = initial.replace('Initial.', 'Updated diagram.');
    await writeFile(source, initial);
    const store = new MetadataStore(join(dir, 'data'));
    const projects = new ProjectService(store);
    await projects.open(root);
    const id = projects.snapshot().id;
    const builds = new BuildService(projects, join(dir, 'builds'));
    const agents = new AgentService(projects, builds, join(dir, 'data'));
    try {
      await writeFile(source, revised);
      await projects.run(() => projects.refresh());
      const native = {
        messages: async () => [],
        pending: async () => ({ permissions: [], questions: [] }),
        active: async () => false,
        session: async () => ({ time: { idle: Date.now() + 1000 }, outcome: 'succeeded' }),
      };
      const turn = {
        view: { startedAt: new Date().toISOString(), changes: [{ path: 'main.tex' }] },
      };
      const internal = agents as unknown as Internal;
      Object.assign(internal, {
        adapter: native,
        projectId: id,
        sessions: [],
        state: {
          projectId: id,
          harness: 'opencode',
          sessionId: 'native',
          running: true,
          connection: 'connected',
          permissions: [],
          questions: [],
          turns: [],
          error: '',
        },
        changes: {
          running: () => turn,
          observe: async () => {},
          finish: async () => {},
          views: () => [],
          linkSubmittedAttachments: vi.fn(),
        },
      });
      await Promise.race([
        internal.refresh(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('project queue deadlock')), 5000),
        ),
      ]);
      await projects.run(() => projects.refresh());
      await builds.idle(id);
      const result = await builds.status(id);
      expect(result.current?.status, result.current?.log).toBe('succeeded');
      expect(result.successful?.revision).toBe(projects.snapshot().sourceRevision);
      expect(
        await readFile(join(builds.artifact(id, result.successful!.id).source, 'main.tex'), 'utf8'),
      ).toBe(revised);
    } finally {
      // This fixture supplies a minimal adapter; clear it before closing the real service.
      (agents as unknown as Internal).adapter = null;
      await agents.close();
      builds.dispose();
      await builds.idle(id);
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

it('passes earlier public conversation context to the newly selected harness without changing native session identity', async () => {
  const { service } = make();
  const submit = vi.fn(async () => {});
  const model = { id: 'm', providerId: 'codex', name: 'Model', images: false, tools: true };
  const ref = {
    id: 'chat',
    title: 'Existing',
    harness: 'codex',
    nativeSessions: { opencode: 'open-native', codex: 'codex-native' },
    history: [
      { id: 'one', harness: 'opencode', role: 'user', text: 'Earlier author question', state: '' },
      {
        id: 'two',
        harness: 'opencode',
        role: 'assistant',
        text: 'Earlier public answer',
        state: '',
      },
      { id: 'three', harness: 'opencode', role: 'tool', text: 'Private tool detail', state: '' },
    ],
  };
  const state = {
    ...service.state,
    harness: 'codex',
    settings: { permissionMode: 'supervised', reasoning: '' },
    models: [model],
    toolsAvailable: false,
    sessionUnavailable: false,
  };
  Object.assign(service, {
    adapter: { submit, ownership: 'loom' },
    builds: { status: vi.fn(async () => null) },
    state,
    sessions: [ref],
    queue: Promise.resolve(),
    bind: async () => {},
    projectId: 'paper',
    persisted: '',
    changes: {
      unsettled: () => false,
      begin: async () => {},
      views: () => [],
      linkSubmittedAttachments: vi.fn(),
    },
    projects: {
      run: async (f: () => unknown) => f(),
      buildContext: () => ({ root: '/paper', snapshot: { name: 'Synthetic' }, files: [] }),
      store: { set: vi.fn() },
    },
  });
  await (service as unknown as AgentService).command({
    type: 'send',
    projectId: 'paper',
    sessionId: 'chat',
    prompt: 'New question',
    model,
    attachments: [],
    selection: null,
    revision: 'revision',
  });
  expect(submit).toHaveBeenCalledOnce();
  const [native, prompt] = submit.mock.calls[0] as unknown as [string, string];
  expect(native).toBe('codex-native');
  expect(prompt).toContain('Earlier author question');
  expect(prompt).toContain('Earlier public answer');
  expect(prompt).not.toContain('Private tool detail');
  expect(prompt).toContain('New question');
  expect(prompt).toContain('Loom diagnostic context');
  expect(prompt).toContain('buildStatusAvailable');
});
