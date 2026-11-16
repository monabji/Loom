import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { OpenCodeAdapter, privateEndpoint } from '../src/services/agents/opencode';
import { AgentRequestError } from '../src/services/agents/request-error';
it('restricts attachment to explicit loopback origins', () => {
  for (const url of [
    'https://127.0.0.1:1',
    'http://localhost:1',
    'http://example.com',
    'http://127.0.0.1:1/path',
    'http://user:password@127.0.0.1:1',
    'http://127.0.0.1:1?secret=x',
  ])
    expect(() => privateEndpoint(url)).toThrow();
  expect(privateEndpoint('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
});
it('uses actual structured SDK permission/question bodies, refuses redirects and leaves attached server alive', async () => {
  let version = '2.2.1',
    redirect = false,
    rejectPrompt = false;
  const operations: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    if (
      req.headers.authorization !==
      'Basic ' + Buffer.from('opencode:synthetic-password').toString('base64')
    ) {
      res.writeHead(401).end();
      return;
    }
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    if (path === '/api/info' && redirect) {
      res.writeHead(302, { Location: '/unexpected' }).end();
      return;
    }
    if (path === '/api/session/session/prompt' && rejectPrompt) {
      res
        .writeHead(413, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ name: 'Payload Too Large', data: { message: 'Image too large.' } }));
      return;
    }
    let body: unknown;
    let text = '';
    for await (const part of req) text += part.toString();
    if (text) body = JSON.parse(text);
    operations.push({ path, body });
    const value = path === '/api/info' ? { version } : path === '/api/model' ? { data: [] } : {};
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address.');
  const endpoint = `http://127.0.0.1:${address.port}`,
    adapter = new OpenCodeAdapter(endpoint, 'synthetic-password');
  try {
    await adapter.verify();
    expect(await adapter.models('/synthetic')).toEqual([]);
    await adapter.permission('session', 'permission', 'once');
    await adapter.answer('session', 'question', { audience: 'Researchers' });
    expect(operations).toContainEqual({
      path: '/api/session/session/permission/permission/reply',
      body: { decision: 'once' },
    });
    expect(operations).toContainEqual({
      path: '/api/session/session/form/question/reply',
      body: { answer: { audience: 'Researchers' } },
    });
    rejectPrompt = true;
    await expect(
      adapter.request('POST', '/api/session/session/prompt', { files: [] }),
    ).rejects.toMatchObject<Partial<AgentRequestError>>({
      status: 413,
      disposition: 'rejected',
      message: expect.stringContaining('HTTP 413'),
    });
    rejectPrompt = false;
    version = '9.0.0';
    await expect(adapter.verify()).resolves.toBeUndefined();
    expect(adapter.version).toBe('9.0.0');
    redirect = true;
    await expect(adapter.verify()).rejects.toThrow('outcome is uncertain');
    expect(operations.some((o) => o.path === '/unexpected')).toBe(false);
    redirect = false;
    version = '2.2.1';
    await adapter.close();
    expect(
      (
        await fetch(endpoint + '/api/info', {
          headers: {
            Authorization: 'Basic ' + Buffer.from('opencode:synthetic-password').toString('base64'),
          },
        })
      ).status,
    ).toBe(200);
  } finally {
    await adapter.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
