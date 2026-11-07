import { createClient } from '@opencode-ai/sdk/v2/gen/client';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageMime } from '../../domain/images';
import { openCodeExecution } from './evidence';
import { agentRequestError, readAgentSession } from './request-error';
import type { AgentMessage, AgentModel, AgentSettings } from '../../contracts/agent';
import type { spawnOwnedTool } from '../latex/tools';
import { list, object, privateEndpoint, string, type HarnessAdapter } from './opencode';

export const supportedClassicVersion = (version: string) => /^1\.19\.\d+(?:$|[-+])/.test(version);
const query = (directory: string) => '?directory=' + encodeURIComponent(directory);
const sessionPath = (id: string) => '/session/' + encodeURIComponent(id);

/** Transport for the native 1.19 API. OpenCode owns the execution loop and history. */
export class OpenCodeClassicAdapter implements HarnessAdapter {
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
  private directory = '';
  private turns = new Map<
    string,
    { startedAt: number; sawActive: boolean; abortAccepted: boolean; idleAt: number }
  >();
  version = '';
  ownership: 'loom' | 'external' = 'external';
  onEvent?: (event: Record<string, unknown>) => void;
  onLost?: () => void;
  get supervisorPid() {
    return this.process?.pid;
  }
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
  adoptProcess(child: ReturnType<typeof spawnOwnedTool>) {
    this.process = child;
    this.ownership = 'loom';
    child.stdout.resume();
    child.stderr.resume();
    child.once('exit', () => this.onLost?.());
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
  async verify() {
    let health: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        health = object(await this.request('GET', '/global/health'));
        break;
      } catch (error) {
        // A restarted classic server can reuse port 4096 while fetch retains an old socket.
        // Retry this read-only health probe, never prompts, writes or permission decisions.
        if (!(error instanceof Error && error.cause instanceof TypeError) || attempt === 2)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }
    if (!health) throw new Error('OpenCode did not report a healthy server.');
    this.version = string(health.version);
    if (health.healthy !== true || !supportedClassicVersion(this.version))
      throw new Error(
        `OpenCode ${this.version || 'unknown'} is incompatible. This adapter supports 1.19.x.`,
      );
  }
  async configureTools(directory: string, url: string, token: string) {
    if (this.ownership !== 'loom')
      throw new Error('Cannot configure tools on an attached OpenCode server.');
    const result = object(
      await this.request('POST', '/mcp' + query(directory), {
        name: 'loom',
        config: {
          type: 'remote',
          url,
          enabled: true,
          headers: { Authorization: `Bearer ${token}` },
          oauth: false,
        },
      }),
    );
    if (string(object(result.loom).status) !== 'connected')
      throw new Error('OpenCode could not connect the Loom tools.');
  }
  async models(directory: string): Promise<AgentModel[]> {
    this.directory = directory;
    const catalog = object(await this.request('GET', '/provider' + query(directory)));
    const connected = list(catalog.connected).map((v) => string(v));
    const defaults = object(catalog.default);
    const models: AgentModel[] = [];
    for (const raw of list(catalog.all)) {
      const provider = object(raw),
        providerId = string(provider.id);
      if (!connected.includes(providerId)) continue;
      for (const rawModel of Object.values(object(provider.models))) {
        const model = object(rawModel),
          caps = object(model.capabilities),
          input = object(caps.input);
        const variants = model.variants ? Object.keys(object(model.variants)) : [];
        if (!string(model.id) || model.status === 'deprecated') continue;
        models.push({
          id: string(model.id),
          providerId,
          name: string(model.name, string(model.id)),
          images: input.image === true,
          tools: caps.toolcall === true,
          ...(variants.length ? { reasoningEfforts: variants } : {}),
        });
      }
    }
    models.sort(
      (a, b) => Number(defaults[b.providerId] === b.id) - Number(defaults[a.providerId] === a.id),
    );
    return models.slice(0, 3000);
  }
  async authentication(directory: string): Promise<'available' | 'required' | 'unknown'> {
    try {
      const catalog = object(await this.request('GET', '/provider' + query(directory)));
      return list(catalog.connected).length ? 'available' : 'required';
    } catch {
      return 'unknown';
    }
  }
  async create(directory: string) {
    this.directory = directory;
    const result = object(
      await this.request('POST', '/session' + query(directory), {
        title: 'Paper conversation',
        agent: 'build',
      }),
    );
    const id = string(result.id);
    if (!id || string(result.directory) !== directory)
      throw new Error('OpenCode returned an invalid paper session.');
    return id;
  }
  private path(id: string) {
    return sessionPath(id) + query(this.directory);
  }
  async session(id: string) {
    const result = object(await readAgentSession(() => this.request('GET', this.path(id))));
    const messages = list(
      await this.request('GET', sessionPath(id) + '/message' + query(this.directory)),
    );
    const user = [...messages]
      .reverse()
      .map(object)
      .find((m) => object(m.info).role === 'user');
    const userInfo = user ? object(user.info) : null;
    const assistant = userInfo
      ? [...messages]
          .reverse()
          .map(object)
          .find((m) => {
            const info = object(m.info);
            return info.role === 'assistant' && info.parentID === userInfo.id;
          })
      : undefined;
    const info = assistant ? object(assistant.info) : null;
    const completed = info ? Number(object(info.time).completed) : 0;
    const finish = info ? string(info.finish) : '';
    const turn = this.turns.get(id);
    const terminal =
      completed > 0 &&
      (!turn || completed >= turn.startedAt) &&
      (Boolean(info?.error) || finish === 'stop');
    const error = info?.error ? object(info.error) : null;
    const outcome = !terminal
      ? ''
      : error
        ? string(error.name).includes('Aborted')
          ? 'interrupted'
          : 'failed'
        : 'succeeded';
    return {
      ...result,
      location: { directory: string(result.directory) },
      time: { ...object(result.time), idle: turn?.idleAt || (terminal ? completed : 0) },
      outcome: turn?.idleAt ? 'interrupted' : outcome,
    };
  }
  async submit(
    id: string,
    prompt: string,
    model: AgentModel,
    files: string[],
    settings?: AgentSettings,
  ) {
    if (settings) {
      const mode = settings.permissionMode;
      const readRules = ['read', 'glob', 'grep', 'list', 'question'].map((permission) => ({
        permission,
        pattern: '*',
        action: 'allow',
      }));
      const permission =
        mode === 'full-access'
          ? [{ permission: '*', pattern: '*', action: 'allow' }]
          : [
              { permission: '*', pattern: '*', action: 'ask' },
              ...readRules,
              ...(mode === 'auto-accept-edits' || mode === 'auto'
                ? ['edit', 'write'].map((permission) => ({
                    permission,
                    pattern: '*',
                    action: 'allow',
                  }))
                : []),
            ];
      await this.request('PATCH', this.path(id), { permission });
    }
    this.turns.set(id, {
      startedAt: Date.now(),
      sawActive: false,
      abortAccepted: false,
      idleAt: 0,
    });
    await this.request('POST', sessionPath(id) + '/prompt_async' + query(this.directory), {
      agent: 'build',
      model: { providerID: model.providerId, modelID: model.id },
      ...(settings?.reasoning ? { variant: settings.reasoning } : {}),
      parts: [
        { type: 'text', text: prompt },
        ...files.map((path) => ({
          type: 'file',
          mime: imageMime(path) ?? 'text/plain',
          filename: basename(path),
          url: pathToFileURL(path).href,
        })),
      ],
    });
  }
  async interrupt(id: string) {
    await this.active(id);
    const turn = this.turns.get(id)!;
    const accepted = await this.request('POST', sessionPath(id) + '/abort' + query(this.directory));
    if (accepted !== true) throw new Error('OpenCode did not confirm the request to stop.');
    if (this.turns.get(id) === turn) turn.abortAccepted = true;
  }
  async active(id: string) {
    let turn = this.turns.get(id);
    if (!turn) {
      turn = { startedAt: 0, sawActive: false, abortAccepted: false, idleAt: 0 };
      this.turns.set(id, turn);
    }
    const canConfirmAbort = turn.abortAccepted && turn.sawActive;
    const status = object(await this.request('GET', '/session/status' + query(this.directory)));
    const active = status[id] !== undefined && string(object(status[id]).type) !== 'idle';
    if (this.turns.get(id) === turn) {
      if (active) turn.sawActive = true;
      else if (canConfirmAbort && !turn.idleAt) turn.idleAt = Date.now();
    }
    return active;
  }
  async messages(id: string): Promise<AgentMessage[]> {
    const messages = list(
      await this.request('GET', sessionPath(id) + '/message' + query(this.directory)),
    );
    const result: AgentMessage[] = [];
    for (const raw of messages) {
      const message = object(raw),
        info = object(message.info),
        mid = string(info.id),
        role = string(info.role);
      let text = '';
      for (const rawPart of list(message.parts)) {
        const part = object(rawPart);
        if (part.type === 'text' && part.synthetic !== true && part.ignored !== true)
          text += string(part.text);
        if (role === 'assistant' && part.type === 'tool')
          result.push({
            id: mid + ':' + string(part.id),
            role: 'tool',
            text: string(part.tool),
            state: string(object(part.state).status),
            execution: openCodeExecution(string(part.tool), object(part.state), true),
          });
      }
      if (text && (role === 'user' || role === 'assistant'))
        result.push({ id: mid, role, text: text.slice(0, 100000), state: '' });
      if (role === 'assistant' && info.error)
        result.push({
          id: mid + ':error',
          role: 'status',
          text: string(object(info.error).name).includes('Aborted')
            ? 'Request stopped · partial work is retained'
            : 'The provider could not complete this response. Check model access in OpenCode.',
          state: string(object(info.error).name).includes('Aborted') ? 'interrupted' : 'failed',
        });
    }
    return result.slice(-200);
  }
  async pending(id: string) {
    const [permissions, questions] = await Promise.all([
      this.request('GET', '/permission' + query(this.directory)),
      this.request('GET', '/question' + query(this.directory)),
    ]);
    return {
      permissions: list(permissions)
        .map(object)
        .filter((p) => p.sessionID === id)
        .map((p) => ({ id: p.id, action: p.permission, resources: p.patterns })),
      questions: list(questions)
        .map(object)
        .filter((q) => q.sessionID === id)
        .map((q) => ({
          id: q.id,
          title: 'OpenCode question',
          rejectable: true,
          fields: list(q.questions).map((v, i) => {
            const item = object(v);
            return {
              key: String(i),
              title: string(item.header),
              description: string(item.question),
              type: item.multiple === true ? 'multiselect' : 'string',
              required: true,
              options: list(item.options).map((v) => {
                const option = object(v);
                return { value: string(option.label), label: string(option.label) };
              }),
            };
          }),
        })),
    };
  }
  async permission(_sessionId: string, id: string, reply: 'once' | 'reject') {
    await this.request(
      'POST',
      '/permission/' + encodeURIComponent(id) + '/reply' + query(this.directory),
      { reply },
    );
  }
  async answer(_sessionId: string, id: string, answer: unknown, reject?: boolean) {
    const path =
      '/question/' +
      encodeURIComponent(id) +
      (reject ? '/reject' : '/reply') +
      query(this.directory);
    if (reject) await this.request('POST', path);
    else {
      const values = object(answer);
      const answers = Object.keys(values)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => (Array.isArray(values[k]) ? values[k] : [String(values[k])]));
      await this.request('POST', path, { answers });
    }
  }
  async stream() {
    const response = await this.client.sse.get({
      url: '/event' + query(this.directory),
      signal: this.events.signal,
      sseMaxRetryAttempts: 1,
    });
    void (async () => {
      try {
        for await (const event of response.stream)
          this.onEvent?.(object(typeof event === 'string' ? JSON.parse(event) : event));
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
