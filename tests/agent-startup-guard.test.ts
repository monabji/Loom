import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MetadataStore } from '../src/services/project/store';
import { ProjectService } from '../src/services/project/projects';

it('fails closed when future session references hide an unsettled external turn', async () => {
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

  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./helpers/agent-startup-guard-child.mjs', import.meta.url)), data],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOOM_GUARD_PROJECT: project.id,
          LOOM_GUARD_FILE: project.files[0].id,
          LOOM_GUARD_ROOT: root,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(code, stderr).toBe(0);
    const { agent, mutation, switching, read } = JSON.parse(stdout) as Record<
      string,
      { ok: boolean; error?: { message: string } }
    >;
    for (const response of [agent, mutation, switching]) {
      expect(response.ok).toBe(false);
      expect(response.error?.message).toContain('Agent recovery could not be initialized');
      expect(response.error?.message).toContain('Keep your application data');
    }
    expect(read.ok).toBe(true);
    expect(
      await import('node:fs/promises').then((fs) => fs.readFile(join(root, 'main.tex'), 'utf8')),
    ).toBe('author work');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
