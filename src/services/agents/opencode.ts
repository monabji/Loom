import { createClient } from '@opencode-ai/sdk/v2/gen/client';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runTool, spawnOwnedTool } from '../latex/tools';
import type { AgentMessage, AgentModel, AgentSettings } from '../../contracts/agent';

import { harnessExecutable } from './runtime';
import { openCodeServerEndpoint } from './startup';
import { OpenCodeClassicAdapter, supportedClassicVersion } from './opencode-classic';
import { openCodeExecution } from './evidence';
import { agentRequestError, readAgentSession } from './request-error';

const nativeObject = z.record(z.string(), z.unknown());
export const object = (value: unknown): Record<string, unknown> => nativeObject.parse(value);
export const list = (value: unknown): unknown[] => z.array(z.unknown()).parse(value);
export const string = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;
export const dataList = (value: unknown) => list(object(value).data);
export function supportedVersion(version: string) {
  return /^2\.2\.(?:[1-9]\d*)(?:$|[-+])/.test(version);
}
export function privateEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Use a private loopback address such as http://127.0.0.1:4096.');
  return url.origin;
}
export type HarnessCapabilities = {
  streaming: boolean;
  permissions: boolean;
  questions: boolean;
  nativeWrites: boolean;
  images: boolean;
};
export interface HarnessAdapter {
  readonly supervisorPid?: number;
  version: string;
  ownership: 'loom' | 'external';
  onEvent?: (event: Record<string, unknown>) => void;
  onLost?: () => void;
  session(sessionId: string): Promise<Record<string, unknown>>;
  active(sessionId: string): Promise<boolean>;
  pending(
    sessionId: string,
  ): Promise<{ permissions: Record<string, unknown>[]; questions: Record<string, unknown>[] }>;
  permission(sessionId: string, id: string, reply: 'once' | 'reject'): Promise<void>;
  answer(sessionId: string, id: string, answer: unknown, reject?: boolean): Promise<void>;
  readonly capabilities: HarnessCapabilities;
  models(directory: string): Promise<AgentModel[]>;
  create(directory: string): Promise<string>;
  submit(
    sessionId: string,
    prompt: string,
    model: AgentModel,
    files: string[],
    settings?: AgentSettings,
  ): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  messages(sessionId: string): Promise<AgentMessage[]>;
  close(): Promise<void>;
}
/** OpenCode owns execution. This adapter transports structured API/SSE only. */
export class OpenCodeAdapter implements HarnessAdapter {
  get supervisorPid() {
    return this.process?.pid;
  }
  readonly capabilities = {
    streaming: true,
    permissions: true,
    questions: true,
    nativeWrites: true,
    images: true,
  };
  private client: ReturnType<typeof createClient>;
  private process: ReturnType<typeof spawnOwnedTool> | null = null;
  private events = new AbortController();
  version = '';
  ownership: 'loom' | 'external' = 'external';
  onEvent?: (event: Record<string, unknown>) => void;
  onLost?: () => void;
  constructor(endpoint: string, password: string, username = 'opencode') {
    this.client = createClient({
      baseUrl: privateEndpoint(endpoint),
      headers: {
        Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
      },
      throwOnError: true,
      responseStyle: 'data',
      fetch: async (input, init) => fetch(input, { ...init, redirect: 'error' }),
    });
    this.client.interceptors.error.use((error, response) =>
      response
        ? new Error('OpenCode returned an HTTP error response.', {
            cause: { status: response.status },
          })
        : error,
    );
  }
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.client.request({
        method,
        url: path,
        ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
        signal: signal ?? AbortSignal.timeout(12000),
        responseStyle: 'data',
        throwOnError: true,
      });
    } catch (error) {
      throw agentRequestError('OpenCode', error);
    }
  }
  static async detect(override?: string) {
    let executable: string | null = null;
    try {
      executable = await harnessExecutable('opencode', override);
      if (!executable) return { installed: false, version: 'Not installed', executable: null };
      const r = await runTool(executable, ['--version'], { timeoutMs: 5000 });
      const version = r.output.match(/(?:v)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1] ?? 'Unknown';
      return { installed: r.code === 0, version, executable };
    } catch {
      return {
        installed: false,
        version: executable ? 'Version check failed' : 'Binary path unavailable',
        executable,
      };
    }
  }
  static async owned(directory: string, executable?: string) {
    const found = await this.detect(executable);
    if (!found.installed || !found.executable)
      throw new Error(
        'Install OpenCode and sign in with “opencode auth login”, then connect again.',
      );
    if (!supportedVersion(found.version) && !supportedClassicVersion(found.version))
      throw new Error(
        `OpenCode ${found.version} is not supported. This Loom build supports OpenCode 1.19.x and 2.2.x from 2.2.1.`,
      );
    const password = randomBytes(32).toString('hex');
    const child = spawnOwnedTool(
      found.executable,
      ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      directory,
      { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' },
    );
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(
          () => reject(new Error('OpenCode did not start. Check its installation and try again.')),
          10000,
        );
        const finish = (error?: Error, url?: string) => {
          clearTimeout(timer);
          child.stdout.removeListener('data', append);
          child.stderr.removeListener('data', append);
          error ? reject(error) : resolve(url!);
        };
        const append = (bytes: Buffer) => {
          output = (output + bytes.toString('utf8')).slice(-4096);
          const endpoint = openCodeServerEndpoint(output);
          if (endpoint) finish(undefined, endpoint);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.once('error', () => finish(new Error('OpenCode could not start.')));
        child.once('exit', () => finish(new Error('OpenCode stopped before connecting.')));
      });
      const adapter = supportedClassicVersion(found.version)
        ? new OpenCodeClassicAdapter(endpoint, password)
        : new OpenCodeAdapter(endpoint, password);
      adapter.adoptProcess(child);
      await adapter.verify();
      // Verify authentication is actually enforced by this server implementation.
      const response = await fetch(
        endpoint + (adapter instanceof OpenCodeClassicAdapter ? '/global/health' : '/api/info'),
        {
          signal: AbortSignal.timeout(3000),
          redirect: 'error',
        },
      );
      if (response.status !== 401)
        throw new Error('OpenCode did not protect its local endpoint. Connection closed.');
      return adapter;
    } catch (error) {
      const stopped =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.stdin.end();
      await stopped;
      throw error;
    }
  }
  adoptProcess(child: ReturnType<typeof spawnOwnedTool>) {
    this.process = child;
    this.ownership = 'loom';
    child.stdout.resume();
    child.stderr.resume();
    child.once('exit', () => this.onLost?.());
  }
  static async attach(endpoint: string, password: string, username = 'opencode') {
    const next = new OpenCodeAdapter(endpoint, password, username);
    try {
      await next.verify();
      return next;
    } catch {
      await next.close();
    }
    const classic = new OpenCodeClassicAdapter(endpoint, password, username);
    await classic.verify();
    return classic;
  }
  async configureTools(directory: string, url: string, token: string) {
    if (this.ownership !== 'loom')
      throw new Error('Loom cannot configure tools on an attached server.');
    await this.request(
      'PUT',
      '/api/experimental/mcp/loom-paper?location[directory]=' + encodeURIComponent(directory),
      { config: { type: 'remote', url, headers: { Authorization: 'Bearer ' + token } } },
    );
  }
  async verify() {
    const info = object(await this.request('GET', '/api/info'));
    this.version = string(info.version);
    if (!supportedVersion(this.version))
      throw new Error(
        `OpenCode ${this.version || 'unknown'} is incompatible. This Loom build supports 2.2.x from 2.2.1.`,
      );
  }
  async models(directory: string): Promise<AgentModel[]> {
    const response = await this.request(
      'GET',
      '/api/model?location[directory]=' + encodeURIComponent(directory),
    );
    const models = dataList(response)
      .map(object)
      .filter((m) => m.enabled === true && m.type === 'chat')
      .map((m) => {
        const c = object(m.capabilities);
        return {
          id: string(m.id),
          providerId: string(m.providerID),
          name: string(m.name),
          images: Array.isArray(c.input) && c.input.includes('image'),
          tools: c.tools === true,
          reasoningEfforts: Array.isArray(m.variants)
            ? m.variants.map((v) => string(object(v).id)).filter(Boolean)
            : [],
        };
      })
      .filter((m) => m.id && m.providerId)
      .slice(0, 3000);
    try {
      const preferred = object(
        object(
          await this.request(
            'GET',
            '/api/model/default?location[directory]=' + encodeURIComponent(directory),
          ),
        ).data,
      );
      const index = models.findIndex(
        (m) => m.id === preferred.id && m.providerId === preferred.providerID,
      );
      if (index > 0) models.unshift(...models.splice(index, 1));
    } catch {
      /* Keep the advertised catalog order when no configured default is available. */
    }
    return models;
  }
  async authentication(directory: string): Promise<'available' | 'required' | 'unknown'> {
    try {
      const integrations = dataList(
        await this.request(
          'GET',
          '/api/integration?location[directory]=' + encodeURIComponent(directory),
        ),
      ).map(object);
      const connections = integrations.flatMap((item) =>
        Array.isArray(item.connections) ? item.connections.map(object) : [],
      );
      if (connections.some((c) => !c.status)) return 'available';
      if (connections.length && connections.every((c) => object(c.status).status === 'needs_auth'))
        return 'required';
    } catch {
      /* An unavailable discovery surface never proves authentication. */
    }
    return 'unknown';
  }
  async create(directory: string) {
    return string(
      object(
        object(
          await this.request('POST', '/api/session', {
            location: { directory },
            title: 'Paper conversation',
          }),
        ).data,
      ).id,
    );
  }
  async session(sessionId: string) {
    return object(
      object(
        await readAgentSession(() =>
          this.request('GET', '/api/session/' + encodeURIComponent(sessionId)),
        ),
      ).data,
    );
  }
  async submit(
    sessionId: string,
    prompt: string,
    model: AgentModel,
    files: string[],
    settings?: AgentSettings,
  ) {
    const path = '/api/session/' + encodeURIComponent(sessionId);
    await this.request('POST', path + '/agent', { agent: 'build' });
    if (settings) {
      const permissions =
        settings.permissionMode === 'full-access'
          ? [{ action: '*', resource: '*', effect: 'allow' }]
          : [
              { action: '*', resource: '*', effect: 'ask' },
              ...[
                'read',
                'glob',
                'grep',
                'list',
                'question',
                ...(settings.permissionMode === 'supervised' ? [] : ['edit', 'write']),
              ].map((action) => ({ action, resource: '*', effect: 'allow' })),
            ];
      await this.request('PATCH', path, { permissions });
    }
    await this.request('POST', path + '/model', {
      model: {
        id: model.id,
        providerID: model.providerId,
        ...(settings?.reasoning ? { variant: settings.reasoning } : {}),
      },
    });
    await this.request('POST', path + '/prompt', {
      text: prompt,
      files: files.map((path) => ({ uri: pathToFileURL(path).href })),
      metadata: { loom: true },
    });
  }
  async interrupt(sessionId: string) {
    await this.request('POST', '/api/session/' + encodeURIComponent(sessionId) + '/interrupt', {});
  }
  async active(sessionId: string) {
    const response = object(await this.request('GET', '/api/session/active'));
    return Object.hasOwn(object(response.data), sessionId);
  }
  async messages(sessionId: string): Promise<AgentMessage[]> {
    const messages = dataList(
      await this.request(
        'GET',
        '/api/session/' + encodeURIComponent(sessionId) + '/message?limit=100&order=desc',
      ),
    ).reverse();
    const result: AgentMessage[] = [];
    for (const raw of messages) {
      const m = object(raw),
        id = string(m.id),
        type = string(m.type);
      if (type === 'user')
        result.push({ id, role: 'user', text: string(m.text).slice(0, 100000), state: '' });
      if (type === 'assistant') {
        const content = list(m.content);
        let text = '';
        for (const item of content) {
          const part = object(item);
          if (part.type === 'text') text += string(part.text);
          if (part.type === 'tool') {
            const state = object(part.state);
            result.push({
              id: id + ':' + string(part.id),
              role: 'tool',
              text: string(part.name),
              state: string(state.status),
              execution: openCodeExecution(string(part.name), state, false),
            });
          }
        }
        if (text) result.push({ id, role: 'assistant', text: text.slice(0, 100000), state: '' });
        if (m.error)
          result.push({
            id: id + ':error',
            role: 'status',
            text: (() => {
              const error = object(m.error);
              const status = typeof error.status === 'number' ? error.status : 0;
              return status === 401 || status === 403
                ? 'Sign in to this provider in OpenCode, then reconnect.'
                : status === 429
                  ? 'The provider is limiting requests. Wait, or choose another model.'
                  : status === 400
                    ? 'The provider rejected this model request. Choose another model or check its configuration in OpenCode.'
                    : 'The provider could not complete this response. Check model access in OpenCode.';
            })(),
            state: 'failed',
          });
      }
      if (type === 'idle')
        result.push({
          id,
          role: 'status',
          text:
            m.outcome === 'succeeded'
              ? 'Request complete'
              : m.outcome === 'interrupted'
                ? 'Request stopped · partial work is retained'
                : 'Request failed · partial work is retained',
          state: string(m.outcome),
        });
    }
    return result.slice(-200);
  }
  async pending(sessionId: string) {
    const path = '/api/session/' + encodeURIComponent(sessionId);
    const [permissions, questions] = await Promise.all([
      this.request('GET', path + '/permission'),
      this.request('GET', path + '/form'),
    ]);
    return {
      permissions: dataList(permissions).map(object),
      questions: dataList(questions).map(object),
    };
  }
  async permission(sessionId: string, id: string, reply: 'once' | 'reject') {
    await this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(id)}/reply`,
      { decision: reply },
    );
  }
  async answer(sessionId: string, id: string, answer: unknown) {
    await this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(id)}/reply`,
      { answer },
    );
  }
  async stream() {
    const response = await this.client.sse.get({
      url: '/api/event',
      signal: this.events.signal,
      sseMaxRetryAttempts: 1,
    });
    void (async () => {
      try {
        for await (const event of response.stream) {
          const value = typeof event === 'string' ? JSON.parse(event) : event;
          this.onEvent?.(object(value));
        }
        if (!this.events.signal.aborted) this.onLost?.();
      } catch {
        if (!this.events.signal.aborted) this.onLost?.();
      }
    })();
  }
  async close() {
    this.events.abort();
    this.onLost = undefined;
    if (this.process) {
      const child = this.process;
      this.process = null;
      const stopped =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.stdin.end();
      await stopped;
    }
  }
}
