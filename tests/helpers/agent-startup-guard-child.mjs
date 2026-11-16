import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const data = process.argv[2];
const port = new EventEmitter();
const messages = [];
port.postMessage = (value) => messages.push(value);
Object.defineProperty(process, 'parentPort', { value: port, configurable: true });
process.argv[2] = data;

const vite = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
});
try {
  await vite.ssrLoadModule(resolve('src/services/index.ts'));
  const send = async (id, type, command) => {
    port.emit('message', { data: { type, id, command } });
    for (let i = 0; i < 100; i++) {
      const found = messages.find((message) => message.id === id);
      if (found) return found.result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No response to ${id}`);
  };
  const agent = await send('agent', 'agent', {
    type: 'status',
    projectId: process.env.LOOM_GUARD_PROJECT,
  });
  const mutation = await send('delete', 'project', {
    type: 'delete',
    fileId: process.env.LOOM_GUARD_FILE,
  });
  const switching = await send('open', 'project', {
    type: 'native-open',
    path: process.env.LOOM_GUARD_ROOT,
  });
  const read = await send('current', 'project', { type: 'current' });
  await new Promise((resolve) =>
    process.stdout.write(JSON.stringify({ agent, mutation, switching, read }), resolve),
  );
} finally {
  await vite.close();
}
// The service owns intervals for its lifetime; this disposable child exits
// after the fixture replies so Windows releases its SQLite handles.
process.exit(0);
