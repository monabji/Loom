import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';

it.each(['incompatible', 'temporary', 'checkpoint'] as const)(
  'protects recovery after %s startup failure and retries when it becomes readable',
  async (failure) => {
    const dir = await mkdtemp(join(tmpdir(), 'loom-agent-init-'));
    const root = join(dir, 'paper');
    const data = join(dir, 'data');
    await mkdir(root);
    await writeFile(join(root, 'main.tex'), 'author work');
    const store = new MetadataStore(data);
    const projects = new ProjectService(store);
    const project = await projects.open(root);
    store.set(`agent-sessions:${project.id}`, JSON.stringify({ version: 999, sessions: [] }));
    store.set(
      `agent-turns:${project.id}`,
      JSON.stringify({
        version: 1,
        turns: [
          {
            view: {
              id: 'turn',
              sessionId: 'session',
              status: 'running',
              startedAt: new Date().toISOString(),
              revision: project.sourceRevision,
              changes: [],
            },
            before: {},
            after: {},
            human: [],
            unsettled: true,
            external: true,
          },
        ],
      }),
    );
    store.close();

    const port = new EventEmitter() as EventEmitter & { postMessage: (value: unknown) => void };
    const messages: Record<string, unknown>[] = [];
    port.postMessage = (value) => {
      messages.push(value as Record<string, unknown>);
      port.emit('response');
    };
    vi.resetModules();
    const { MetadataStore: ServiceStore } = await import('../src/services/project/store');
    let readable = false;
    const get = ServiceStore.prototype.get;
    if (failure !== 'incompatible') {
      const repair = new MetadataStore(data);
      repair.set(`agent-sessions:${project.id}`, JSON.stringify({ version: 2, sessions: [] }));
      repair.set(`agent-turns:${project.id}`, JSON.stringify({ version: 1, turns: [] }));
      repair.close();
      if (failure === 'temporary') {
        vi.spyOn(ServiceStore.prototype, 'get').mockImplementation(function (
          this: InstanceType<typeof ServiceStore>,
          key,
        ) {
          if (!readable && key.startsWith('agent-sessions:'))
            throw new Error('Temporary metadata read failure.');
          return get.call(this, key);
        });
      } else {
        const { AgentChanges } = await import('../src/services/agents/changes');
        const recover = AgentChanges.prototype.recoverInterrupted;
        vi.spyOn(AgentChanges.prototype, 'recoverInterrupted').mockImplementation(function (
          this: InstanceType<typeof AgentChanges>,
        ) {
          if (!readable) return Promise.reject(new Error('Temporary checkpoint read failure.'));
          return recover.call(this);
        });
      }
    }
    const original = Object.getOwnPropertyDescriptor(process, 'parentPort');
    const originalArg = process.argv[2];
    Object.defineProperty(process, 'parentPort', { value: port, configurable: true });
    process.argv[2] = data;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(
      () => 0 as unknown as ReturnType<typeof setInterval>,
    );
    try {
      await import('../src/services/index');
      const send = async (id: string, type: string, command: unknown) => {
        port.emit('message', { data: { type, id, command } });
        for (let i = 0; i < 100; i++) {
          const found = messages.find((message) => message.id === id);
          if (found) return found.result as { ok: boolean; error?: { message: string } };
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`No response to ${id}`);
      };
      const agent = await send('agent', 'agent', { type: 'status', projectId: project.id });
      const mutation = await send('delete', 'project', {
        type: 'delete',
        fileId: project.files[0].id,
      });
      const switching = await send('open', 'project', { type: 'native-open', path: root });
      const read = await send('current', 'project', { type: 'current' });
      for (const response of [agent, mutation, switching]) {
        expect(response.ok).toBe(false);
        expect(response.error?.message).toContain('Agent recovery could not be initialized');
        expect(response.error?.message).toContain('Keep your application data');
      }
      expect(read.ok).toBe(true);
      if (failure !== 'incompatible') {
        readable = true;
        const created = await send('create', 'project', {
          type: 'native-create',
          path: join(dir, 'New paper'),
        });
        expect(created.ok).toBe(true);
        const library = await send('library', 'project', { type: 'library' });
        expect(library).toMatchObject({
          ok: true,
          library: expect.arrayContaining([expect.objectContaining({ name: 'New paper' })]),
        });
        expect(
          await import('node:fs/promises').then((fs) =>
            fs.readFile(join(dir, 'New paper', 'main.tex'), 'utf8'),
          ),
        ).toContain('\\documentclass{article}');
      }
      expect(
        await import('node:fs/promises').then((fs) => fs.readFile(join(root, 'main.tex'), 'utf8')),
      ).toBe('author work');
    } finally {
      vi.restoreAllMocks();
      if (original) Object.defineProperty(process, 'parentPort', original);
      else Reflect.deleteProperty(process, 'parentPort');
      if (originalArg === undefined) delete process.argv[2];
      else process.argv[2] = originalArg;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
