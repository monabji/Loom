import { expect, it } from 'vitest';
import { openCodeServerEndpoint } from '../src/services/agents/startup';
import { findWindowsHarnessExecutable, harnessExecutable } from '../src/services/agents/runtime';
import { agentStateSchema, defaultAgentSettings } from '../src/contracts/agent';
import { OpenCodeAdapter } from '../src/services/agents/opencode';
import { CodexAdapter } from '../src/services/agents/codex';
import { codexTurnPolicy } from '../src/services/agents/codex';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('waits for a complete native announcement when a port is split across stdout chunks', () => {
  expect(openCodeServerEndpoint('Tool connecting http://127.0.0.1:1234\n')).toBeUndefined();
  expect(openCodeServerEndpoint('opencode server listening on http://127.0.0.1:4')).toBeUndefined();
  expect(openCodeServerEndpoint('opencode server listening on http://127.0.0.1:4096\n')).toBe(
    'http://127.0.0.1:4096',
  );
});
it('validates explicit executable paths and maps permission choices to native Codex policies', async () => {
  await expect(harnessExecutable('codex', './codex')).rejects.toThrow('absolute path');
  expect(codexTurnPolicy({ permissionMode: 'supervised', reasoning: '' })).toMatchObject({
    approvalPolicy: 'untrusted',
    sandboxPolicy: { type: 'readOnly' },
  });
  expect(codexTurnPolicy({ permissionMode: 'auto-accept-edits', reasoning: '' })).toMatchObject({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'workspaceWrite' },
  });
  expect(codexTurnPolicy({ permissionMode: 'auto', reasoning: '' }).approvalsReviewer).toBe(
    'auto_review',
  );
  expect(codexTurnPolicy({ permissionMode: 'full-access', reasoning: '' })).toMatchObject({
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
});

it('resolves supported Windows npm native binaries without executing npm shims', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'loom-agent-npm-'));
  try {
    const codex = join(
      prefix,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    );
    const opencode = join(prefix, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    await mkdir(join(codex, '..'), { recursive: true });
    await mkdir(join(opencode, '..'), { recursive: true });
    await writeFile(codex, 'synthetic native executable');
    await writeFile(opencode, 'synthetic native executable');

    expect(await findWindowsHarnessExecutable('codex', [prefix], 'x64')).toBe(codex);
    expect(await findWindowsHarnessExecutable('opencode', [prefix], 'x64')).toBe(opencode);
    expect(await findWindowsHarnessExecutable('codex', ['relative-prefix'], 'x64')).toBeNull();
    expect(await findWindowsHarnessExecutable('codex', [prefix], 'ia32')).toBeNull();
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'win32')(
  'accepts native Windows executable overrides and rejects command shims clearly',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'loom-agent-override-'));
    try {
      const executable = join(directory, 'codex.exe');
      const shim = join(directory, 'codex.cmd');
      await writeFile(executable, 'synthetic executable');
      await writeFile(shim, 'synthetic command shim');
      await expect(harnessExecutable('codex', executable)).resolves.toBe(executable);
      await expect(harnessExecutable('codex', shim)).rejects.toThrow('Select the native .exe');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('transports per-chat settings across the strict public session contract', () => {
  const session = {
    id: 'native-chat',
    harness: 'codex',
    title: 'Paper discussion',
    settings: defaultAgentSettings(),
  };
  expect(agentStateSchema.shape.sessions.parse([session])).toEqual([session]);
  expect(
    agentStateSchema.shape.sessions.safeParse([
      { ...session, settings: { permissionMode: 'unknown', reasoning: '' } },
    ]).success,
  ).toBe(false);
});
it('reports missing custom binaries without breaking discovery of other providers', async () => {
  for (const adapter of [CodexAdapter, OpenCodeAdapter])
    expect(await adapter.detect('/not-a-real-loom-executable')).toMatchObject({
      installed: false,
      version: 'Binary path unavailable',
    });
});
