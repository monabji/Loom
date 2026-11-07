import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CodexAdapter } from '../src/services/agents/codex';
import { AgentRequestError } from '../src/services/agents/request-error';

type Internals = {
  sessions: Map<string, unknown>;
  earlyEvents: Map<string, unknown[]>;
  pendingRPC: Map<number, unknown>;
  child: EventEmitter & {
    stdin: { write: (s: string) => void; end: () => void };
    exitCode: number | null;
    signalCode: string | null;
  };
  receive: (value: unknown) => void;
  rpc: (method: string, params: unknown) => Promise<unknown>;
  ended: boolean;
};
function fixture() {
  const adapter = Object.create(CodexAdapter.prototype) as Pick<CodexAdapter, keyof CodexAdapter> &
    Internals;
  adapter.sessions = new Map();
  adapter.earlyEvents = new Map();
  adapter.pendingRPC = new Map();
  adapter.ended = false;
  const child = new EventEmitter() as Internals['child'];
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.exitCode = null;
  child.signalCode = null;
  adapter.child = child;
  return { adapter, child };
}

describe('Codex adapter protocol boundaries', () => {
  it.each(['once', 'reject'] as const)(
    'shows matching file-change paths without diffs and preserves the %s reply',
    async (reply) => {
      const { adapter, child } = fixture();
      adapter.rpc = vi.fn(async () => ({ thread: { id: 'thread' } }));
      await adapter.create('/paper');
      // Codex 0.159.3 generate-ts: paths belong to ThreadItem.changes,
      // while FileChangeRequestApprovalParams refers to that item by itemId.
      for (const [id, changes] of [
        ['other', [{ path: '/paper/unrelated.tex', kind: { type: 'add' }, diff: 'PRIVATE' }]],
        [
          'patch',
          [
            { path: '/paper/main.tex', kind: { type: 'add' }, diff: 'PRIVATE SOURCE' },
            { path: '/paper/old.tex', kind: { type: 'delete' }, diff: 'PRIVATE SOURCE' },
            {
              path: '/paper/notes.tex',
              kind: { type: 'update', move_path: '/paper/sections/notes.tex' },
              diff: 'SYNTHETIC_SECRET=do-not-display',
            },
          ],
        ],
      ]) {
        adapter.receive({
          method: 'item/started',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            startedAtMs: 1,
            item: { type: 'fileChange', id, changes, status: 'inProgress' },
          },
        });
      }
      adapter.receive({
        id: 104,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'patch',
          startedAtMs: 2,
          reason: null,
          grantRoot: null,
        },
      });
      expect((await adapter.pending('thread')).permissions).toEqual([
        {
          id: '104',
          action: 'Change project files',
          resources: [
            '/paper/main.tex',
            '/paper/old.tex',
            '/paper/notes.tex',
            '/paper/sections/notes.tex',
          ],
        },
      ]);
      expect(child.stdin.write).not.toHaveBeenCalled();
      await adapter.permission('thread', '104', reply);
      expect(child.stdin.write).toHaveBeenCalledWith(
        JSON.stringify({ id: 104, result: { decision: reply === 'once' ? 'accept' : 'decline' } }) +
          '\n',
      );
      expect((await adapter.pending('thread')).permissions).toEqual([]);
    },
  );

  it('keeps file-change paths scoped to their session and active item', async () => {
    const { adapter } = fixture();
    adapter.rpc = vi.fn(async () => ({ thread: { id: 'first' } }));
    await adapter.create('/paper');
    adapter.rpc = vi.fn(async () => ({ thread: { id: 'second' } }));
    await adapter.create('/other');
    const params = {
      threadId: 'first',
      turnId: 'turn',
      item: {
        type: 'fileChange',
        id: 'patch',
        changes: [{ path: '/paper/main.tex', kind: { type: 'add' }, diff: 'PRIVATE' }],
        status: 'inProgress',
      },
    };
    adapter.receive({ method: 'item/started', params });
    for (const threadId of ['first', 'second']) {
      adapter.receive({
        id: threadId,
        method: 'item/fileChange/requestApproval',
        params: { threadId, turnId: 'turn', itemId: 'patch', reason: 'Review this change' },
      });
    }
    expect((await adapter.pending('first')).permissions[0].resources).toEqual(['/paper/main.tex']);
    expect((await adapter.pending('second')).permissions[0].resources).toEqual([
      'Review this change',
    ]);
    adapter.receive({ method: 'item/completed', params });
    expect((await adapter.pending('first')).permissions[0].resources).toEqual([
      'Review this change',
    ]);
  });

  it.each([undefined, [{ path: 42, kind: { type: 'add' }, diff: 'PRIVATE' }]])(
    'keeps the fallback for missing or malformed file-change paths (%j)',
    async (changes) => {
      const { adapter } = fixture();
      adapter.rpc = vi.fn(async () => ({ thread: { id: 'thread' } }));
      await adapter.create('/paper');
      adapter.receive({
        method: 'item/started',
        params: {
          threadId: 'thread',
          item: { type: 'fileChange', id: 'patch', changes, status: 'inProgress' },
        },
      });
      adapter.receive({
        id: 105,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread', itemId: 'patch' },
      });
      expect((await adapter.pending('thread')).permissions[0].resources).toEqual([
        'Requested native operation',
      ]);
    },
  );

  it('exposes the native command and actual completed output and exit status', async () => {
    const { adapter } = fixture();
    adapter.rpc = vi.fn(async () => ({ thread: { id: 'thread' } }));
    await adapter.create('/paper');
    adapter.receive({
      method: 'item/completed',
      params: {
        threadId: 'thread',
        item: {
          id: 'cmd',
          type: 'commandExecution',
          command: 'python -c "print(2)"',
          aggregatedOutput: '2\n',
          exitCode: 0,
          status: 'completed',
        },
      },
    });
    expect(await adapter.messages('thread')).toMatchObject([
      {
        role: 'tool',
        text: 'Command',
        state: 'completed',
        execution: {
          command: 'python -c "print(2)"',
          output: '2\n',
          exitCode: 0,
          truncated: false,
        },
      },
    ]);
  });
  it('sends images as native image inputs and text files as paths', async () => {
    const { adapter } = fixture();
    adapter.rpc = vi.fn(async (method) =>
      method === 'thread/start' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } },
    );
    await adapter.create('/paper');
    await adapter.submit(
      'thread',
      'Transcribe',
      { id: 'model', providerId: 'openai', name: 'Model', images: true, tools: true },
      ['/paper/main.tex', '/paper/board.png'],
    );
    expect(adapter.rpc).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        input: [
          { type: 'text', text: expect.stringContaining('/paper/main.tex'), text_elements: [] },
          { type: 'localImage', path: '/paper/board.png' },
        ],
      }),
    );
  });
  it('keeps the process open and accepts a retry after an explicit turn rejection', async () => {
    const { adapter, child } = fixture();
    adapter.rpc = vi.fn(async () => ({ thread: { id: 'thread' } }));
    await adapter.create('/paper');
    let rejectNextTurn = true;
    adapter.rpc = vi.fn(async (method) => {
      if (method === 'turn/start' && rejectNextTurn) {
        rejectNextTurn = false;
        throw new AgentRequestError('Codex rejected turn/start.', null, 'rejected');
      }
      return { turn: { id: 'turn-2' } };
    });

    await expect(
      adapter.submit(
        'thread',
        'Try the image again.',
        { id: 'model', providerId: 'openai', name: 'Model', images: true, tools: true },
        ['/paper/board.png'],
      ),
    ).rejects.toMatchObject({ disposition: 'rejected' });
    expect(await adapter.active('thread')).toBe(false);
    expect(child.stdin.end).not.toHaveBeenCalled();

    await adapter.submit(
      'thread',
      'Continue after the rejection.',
      { id: 'model', providerId: 'openai', name: 'Model', images: true, tools: true },
      [],
    );
    expect(await adapter.active('thread')).toBe(true);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });
  it('replays early turn, stream and approval events and sends native decisions', async () => {
    const { adapter, child } = fixture();
    adapter.rpc = vi.fn(async () => ({ thread: { id: 'thread' } }));
    adapter.receive({
      method: 'turn/started',
      params: { threadId: 'thread', turn: { id: 'turn' } },
    });
    adapter.receive({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread', itemId: 'item', delta: 'Hello' },
    });
    adapter.receive({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread', command: 'inspect', availableDecisions: ['accept', 'decline'] },
    });
    expect(await adapter.create('/paper')).toBe('thread');
    expect(await adapter.active('thread')).toBe(true);
    expect(await adapter.messages('thread')).toMatchObject([{ text: 'Hello' }]);
    expect((await adapter.pending('thread')).permissions[0].id).toBe('99');
    await adapter.permission('thread', '99', 'reject');
    expect(child.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ id: 99, result: { decision: 'decline' } }) + '\n',
    );
    await adapter.interrupt('thread');
    expect(adapter.rpc).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread',
      turnId: 'turn',
    });
    expect(await adapter.active('thread')).toBe(true);
    adapter.receive({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } },
    });
    expect(await adapter.active('thread')).toBe(false);
    expect((await adapter.session('thread')).outcome).toBe('interrupted');
  });
  it('retains an existing live session and restores active resumed turns and history', async () => {
    const { adapter } = fixture();
    adapter.rpc = vi.fn(async () => ({
      thread: {
        cwd: '/paper',
        status: { type: 'active' },
        turns: [
          {
            id: 'turn',
            status: 'inProgress',
            items: [{ id: 'old', type: 'agentMessage', text: 'Earlier' }],
          },
        ],
      },
    }));
    await adapter.resume('thread', '/paper');
    expect(await adapter.active('thread')).toBe(true);
    expect(await adapter.messages('thread')).toMatchObject([{ text: 'Earlier' }]);
    await adapter.resume('thread', '/paper');
    expect(adapter.rpc).toHaveBeenCalledTimes(1);
    await expect(adapter.resume('thread', '/other')).rejects.toThrow('different paper folder');
  });
  it('waits for the supervised child to exit before close resolves', async () => {
    const { adapter, child } = fixture();
    let settled = false;
    const closing = adapter.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.stdin.end).toHaveBeenCalled();
    child.emit('close');
    await closing;
    expect(settled).toBe(true);
  });
});

it('surfaces native MCP consent instead of rejecting paper tool calls', async () => {
  const { adapter, child } = fixture();
  adapter.rpc = vi.fn(async () => ({ thread: { id: 'thread' } }));
  await adapter.create('/paper');
  adapter.receive({
    id: 101,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread',
      serverName: 'loom',
      mode: 'form',
      message: 'Allow the paper structure tool?',
      requestedSchema: {
        type: 'object',
        properties: { allow: { type: 'boolean', title: 'Allow tool' } },
        required: ['allow'],
      },
    },
  });
  expect(child.stdin.write).not.toHaveBeenCalled();
  expect((await adapter.pending('thread')).questions).toMatchObject([
    { id: '101', title: 'Allow the paper structure tool?' },
  ]);
  await adapter.answer('thread', '101', { allow: true });
  expect(child.stdin.write).toHaveBeenCalledWith(
    JSON.stringify({ id: 101, result: { action: 'accept', content: { allow: true } } }) + '\n',
  );
});

it('handles native filesystem grants and MCP denial without inventing approval decisions', async () => {
  const { adapter, child } = fixture();
  adapter.rpc = vi.fn(async () => ({ thread: { id: 'thread' } }));
  await adapter.create('/paper');
  adapter.receive({
    id: 102,
    method: 'item/permissions/requestApproval',
    params: { threadId: 'thread', permissions: { fileSystem: { write: ['/paper'] } } },
  });
  expect((await adapter.pending('thread')).permissions).toMatchObject([
    { id: '102', action: 'Grant access for this agent request' },
  ]);
  await adapter.permission('thread', '102', 'once');
  expect(child.stdin.write).toHaveBeenLastCalledWith(
    JSON.stringify({
      id: 102,
      result: { permissions: { fileSystem: { write: ['/paper'] } }, scope: 'turn' },
    }) + '\n',
  );
  adapter.receive({
    id: 103,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread',
      serverName: 'loom',
      mode: 'form',
      message: 'Approve?',
      requestedSchema: { type: 'object', properties: {} },
    },
  });
  await adapter.answer('thread', '103', {}, true);
  expect(child.stdin.write).toHaveBeenLastCalledWith(
    JSON.stringify({ id: 103, result: { action: 'decline' } }) + '\n',
  );
});
