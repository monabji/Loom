import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';
import { BuildService } from '../src/services/latex/builds';
import { AgentService } from '../src/services/agents/service';
import { OpenCodeAdapter } from '../src/services/agents/opencode';
import { AgentRequestError } from '../src/services/agents/request-error';
import { readConversations } from '../src/services/agents/conversations';
import type { AgentState } from '../src/contracts/agent';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
const model = { id: 'm', providerId: 'p', name: 'Model', images: false, tools: true, reasoningEfforts: ['low'] };
const settings = { permissionMode: 'supervised', reasoning: 'low' } as const;
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'loom-session-recovery-'));
  const root = join(dir, 'paper');
  await mkdir(root);
  await writeFile(join(root, 'main.tex'), 'Author manuscript');
  const store = new MetadataStore(join(dir, 'data'));
  const projects = new ProjectService(store);
  const project = await projects.open(root);
  const key = `agent-sessions:${project.id}`;
  store.set(key, JSON.stringify({ version: 2, sessionId: 'logical', sessions: [{
    id: 'logical', title: 'Research', titleEdited: true, harness: 'opencode', settings,
    nativeSettings: { opencode: settings }, nativeSessions: { opencode: 'missing-native' },
    history: [{ id: 'old', harness: 'opencode', role: 'assistant', text: 'Keep the original evidence.', state: '' }],
  }] }));
  const builds = new BuildService(projects, dir);
  const agents = new AgentService(projects, builds, dir);
  await agents.initialize();
  const adapter = new OpenCodeAdapter('http://127.0.0.1:1234', '');
  const request = vi.spyOn(adapter, 'request').mockImplementation(async (_method, path) => {
    if (path.includes('missing-native')) throw new AgentRequestError('Missing', 404, 'rejected');
    return { data: { location: { directory: root } } };
  });
  const create = vi.spyOn(adapter, 'create').mockResolvedValue('new-native');
  vi.spyOn(adapter, 'active').mockResolvedValue(false);
  vi.spyOn(adapter, 'messages').mockResolvedValue([]);
  vi.spyOn(adapter, 'pending').mockResolvedValue({ permissions: [], questions: [] });
  const submit = vi.spyOn(adapter, 'submit').mockResolvedValue();
  const attach = (service: AgentService) => {
    const state = Reflect.get(service, 'state') as AgentState;
    Object.assign(state, { connection: 'connected', models: [model], version: '2.2.1', ownership: 'external' });
    Object.assign(service, { adapter });
  };
  attach(agents);
  disposers.push(async () => { await agents.close(); builds.dispose(); store.close(); await rm(dir, {recursive: true, force: true}); });
  return { agents, adapter, request, create, submit, project, store, projects, builds, dir, key, root, attach };
}

describe('saved native session recovery', () => {
  it('selects a missing chat with retained history and structured recovery, without sending', async () => {
    const f = await setup();
    const state = await f.agents.command({ type: 'session', projectId: f.project.id, sessionId: 'logical' });
    expect(state).toMatchObject({ connection: 'connected', sessionId: 'logical', sessionUnavailable: true, restore: { reason: 'missing', sessionId: 'logical' }, settings, messages: [{ text: 'Keep the original evidence.' }] });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503, null])('retries %s errors without replacing or resending', async (status) => {
    const f = await setup();
    f.request.mockRejectedValue(new AgentRequestError('Raw diagnostic must not leak', status, 'unknown'));
    const blocked = await f.agents.command({ type: 'session', projectId: f.project.id, sessionId: 'logical' });
    expect(blocked.restore?.reason).toBe(status === 401 || status === 403 ? 'auth' : 'retryable');
    expect(blocked.error).not.toContain('Raw diagnostic');
    await expect(f.agents.command({ type: 'recover-session', projectId: f.project.id, sessionId: 'logical' })).rejects.toThrow('confirmed missing');
    f.request.mockResolvedValue({ data: { location: { directory: f.root } } });
    const retried = await f.agents.command({ type: 'retry-session', projectId: f.project.id, sessionId: 'logical' });
    expect(retried.restore).toBeUndefined();
    expect(retried.sessionUnavailable).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('refuses a wrong folder and revalidates missing before replacement', async () => {
    const f = await setup();
    await f.agents.command({ type: 'session', projectId: f.project.id, sessionId: 'logical' });
    f.request.mockResolvedValue({ data: { location: { directory: '/other-paper' } } });
    const state = await f.agents.command({ type: 'recover-session', projectId: f.project.id, sessionId: 'logical' });
    expect(state.restore?.reason).toBe('folder-mismatch');
    expect(f.create).not.toHaveBeenCalled();
    expect(JSON.parse(f.store.get(f.key)!).sessions[0].nativeSessions.opencode).toBe('missing-native');
  });
  it('refuses recovery while running or while a request remains unsettled', async () => {
    const f = await setup();
    await f.agents.command({ type: 'session', projectId: f.project.id, sessionId: 'logical' });
    const state = Reflect.get(f.agents, 'state') as AgentState;
    state.running = true;
    await expect(f.agents.command({ type: 'recover-session', projectId: f.project.id, sessionId: 'logical' })).rejects.toThrow('settle');
    state.running = false;
    vi.spyOn(Reflect.get(f.agents, 'changes'), 'unsettled').mockReturnValue({});
    await expect(f.agents.command({ type: 'recover-session', projectId: f.project.id, sessionId: 'logical' })).rejects.toThrow('settle');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('replaces only the mapping and durably hands off same-harness history on the next explicit accepted send', async () => {
    const f = await setup();
    await f.agents.command({ type: 'session', projectId: f.project.id, sessionId: 'logical' });
    const reviews = f.store.get(`agent-turns:${f.project.id}`);
    const recovered = await f.agents.command({ type: 'recover-session', projectId: f.project.id, sessionId: 'logical' });
    expect(recovered).toMatchObject({ sessionId: 'logical', settings, sessions: [{ title: 'Research' }], messages: [{ text: 'Keep the original evidence.' }] });
    expect(recovered.restore).toBeUndefined();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.store.get(`agent-turns:${f.project.id}`)).toBe(reviews);
    expect(readConversations(JSON.parse(f.store.get(f.key)!)).sessions[0]).toMatchObject({ pendingHandoff: ['opencode'], nativeSessions: { opencode: 'new-native' } });
    await f.agents.close();
    const restarted = new AgentService(f.projects, f.builds, f.dir);
    disposers.unshift(() => restarted.close());
    await restarted.initialize();
    f.attach(restarted);
    const send = { type: 'send', projectId: f.project.id, sessionId: 'logical', prompt: 'Continue carefully', model, attachments: [], selection: null, revision: f.project.revision } as const;
    f.submit.mockRejectedValueOnce(new AgentRequestError('Auth rejected', 401, 'rejected'));
    await expect(restarted.command({ ...send, attachments: [] })).rejects.toThrow('Auth rejected');
    expect(readConversations(JSON.parse(f.store.get(f.key)!)).sessions[0].pendingHandoff).toEqual(['opencode']);
    await restarted.command({ ...send, attachments: [] });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[1][0]).toBe('new-native');
    expect(f.submit.mock.calls[1][1]).toContain('Earlier public conversation context');
    expect(f.submit.mock.calls[1][1]).toContain('Keep the original evidence.');
    expect(readConversations(JSON.parse(f.store.get(f.key)!)).sessions[0].pendingHandoff).toEqual([]);
  });
});
