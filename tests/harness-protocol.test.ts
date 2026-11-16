import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/services/agents/codex';
import { OpenCodeAdapter } from '../src/services/agents/opencode';
import { OpenCodeClassicAdapter } from '../src/services/agents/opencode-classic';

it.each([
  { protocol: 'modern', version: '1.0.0', missing: 404 },
  { protocol: 'modern', version: '2.3.0', missing: 404 },
  { protocol: 'modern', version: '9.0.0-preview.1', missing: 404 },
  { protocol: 'classic', version: '1.18.29', missing: 404 },
  { protocol: 'classic', version: '1.19.0', missing: 200 },
  { protocol: 'classic', version: '9.0.0', missing: 405 },
])(
  'selects $protocol by its API, independent of version $version',
  async ({ protocol, version, missing }) => {
    const server = createServer((req, res) => {
      if (req.url === '/api/info' && protocol === 'classic') {
        res.writeHead(missing, { 'Content-Type': 'text/html' }).end('<html>OpenCode</html>');
        return;
      }
      const value =
        req.url === '/api/info' ? { version, futureField: true } : { healthy: true, version };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address');
    let adapter: OpenCodeAdapter | OpenCodeClassicAdapter | undefined;
    try {
      adapter = await OpenCodeAdapter.attach(`http://127.0.0.1:${address.port}`, 'password');
      expect(adapter).toBeInstanceOf(
        protocol === 'modern' ? OpenCodeAdapter : OpenCodeClassicAdapter,
      );
      expect(adapter.version).toBe(version);
    } finally {
      await adapter?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each([401, 403, 500, 503])(
  'does not fall back to another protocol after HTTP %i',
  async (status) => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(status, { 'Content-Type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address');
    try {
      await expect(
        OpenCodeAdapter.attach(`http://127.0.0.1:${address.port}`, 'password'),
      ).rejects.toMatchObject({ status });
      expect(paths).toEqual(['/api/info']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.skipIf(process.platform === 'win32').each(['0.104.0', '0.169.0', '9.0.0'])(
  'connects to a compatible Codex %s executable through its native handshake',
  async (version) => {
    const directory = await mkdtemp(join(tmpdir(), 'loom-codex-protocol-'));
    const executable = join(directory, 'codex-fixture');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli ${version}\\n');
  process.exit(0);
}
// Default stdio is supported by old and current app-server releases.
if (process.argv.slice(2).join(' ') !== 'app-server') process.exit(2);
let initialized = false;
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') { initialized = true; return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {userAgent:'fixture', futureField:true};
  else if (!initialized) { process.exit(3); }
  else if (request.method === 'account/read') result = {account:null, requiresOpenaiAuth:false};
  else if (request.method === 'model/list') result = {data:[{id:'model', displayName:'Model'}]};
  else if (request.method === 'thread/start') result = {thread:{id:'thread'}};
  else if (request.method === 'thread/resume') result = {thread:{id:'thread', cwd:request.params.cwd, turns:[], status:{type:'idle'}}};
  else { process.stdout.write(JSON.stringify({id:request.id,error:{code:-32601,message:'Unknown method'}})+'\\n'); return; }
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`,
    );
    await chmod(executable, 0o700);
    let adapter: CodexAdapter | undefined;
    try {
      adapter = await CodexAdapter.owned(directory, undefined, executable);
      expect(adapter.version).toBe(version);
      expect(adapter.auth).toBe('available');
      expect(await adapter.models(directory)).toMatchObject([{ id: 'model', images: true }]);
      const id = await adapter.create(directory);
      expect(id).toBe('thread');
      await adapter.close();
      adapter = await CodexAdapter.owned(directory, undefined, executable);
      await adapter.resume(id, directory);
      expect((await adapter.session(id)).location).toEqual({ directory });
    } finally {
      await adapter?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
