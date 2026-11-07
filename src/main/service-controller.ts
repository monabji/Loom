import type { ResearchCommand, ResearchResult } from '../contracts/research';
import type { AgentCommand, AgentResult } from '../contracts/agent';
import type { LatexCommand, LatexResult } from '../contracts/latex';
import type { ProjectResult } from '../contracts/project';
import type { GitCommand, GitResult } from '../contracts/git';
import {
  failure,
  serviceMessageSchema,
  type Result,
  type ServiceEvent,
  type ServiceStatus,
} from '../contracts/desktop';

export interface ServiceTransport {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: () => void): void;
  onError(listener: () => void): void;
  kill(): void;
}
type Pending = {
  resolve: (result: Result<ServiceStatus>) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Bounded, generation-aware service transport, independent of Electron for testing. */
export class ServiceController {
  private transport: ServiceTransport | undefined;
  private generation = 0;
  private nextId = 0;
  projectLocation: { projectId: string; path: string } | null = null;
  private status: ServiceStatus = { state: 'unavailable', pid: null, version: '0.1.0' };
  private listeners = new Set<(event: ServiceEvent) => void>();
  private projectPending = new Map<
    string,
    { resolve: (result: ProjectResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private researchPending = new Map<
    string,
    { resolve: (result: ResearchResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private latexPending = new Map<
    string,
    { resolve: (result: LatexResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private agentPending = new Map<
    string,
    { resolve: (result: AgentResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private gitPending = new Map<
    string,
    { resolve: (result: GitResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private gitMutationsPending = 0;
  private pending = new Map<string, Pending>();
  private startup: Promise<Result<ServiceStatus>> | undefined;
  private startupResolve: ((result: Result<ServiceStatus>) => void) | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly spawn: () => ServiceTransport,
    private readonly timeoutMs = 5_000,
    private readonly trashProject: (path: string) => Promise<void> = async () => {
      throw new Error('System Trash is unavailable.');
    },
  ) {}

  subscribe(listener: (event: ServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(error?: ServiceEvent['error']): void {
    const event: ServiceEvent = {
      type: 'service-status',
      status: { ...this.status },
      ...(error ? { error } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }

  private finishStartup(result: Result<ServiceStatus>): void {
    clearTimeout(this.startupTimer);
    this.startupResolve?.(result);
    this.startupResolve = undefined;
    this.startup = undefined;
  }

  private unavailable(
    code: 'TIMEOUT' | 'SERVICE_UNAVAILABLE' | 'INVALID_RESPONSE',
    message: string,
    terminate = true,
  ): Result<never> {
    // Retire ownership before terminating: kill may synchronously emit more events.
    // A failed kill must not leave this generation able to resolve newer requests.
    ++this.generation;
    const transport = this.transport;
    this.transport = undefined;
    this.projectLocation = null;
    if (terminate && transport) {
      try {
        transport.kill();
      } catch {
        // Continue resolving callers and clearing timers even if native teardown fails.
      }
    }
    const result = failure(code, message);
    this.status = { state: 'unavailable', pid: null, version: '0.1.0' };
    this.finishStartup(result);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this.pending.clear();
    for (const pending of this.projectPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this.projectPending.clear();
    for (const p of this.researchPending.values()) {
      clearTimeout(p.timer);
      p.resolve(result);
    }
    this.researchPending.clear();
    for (const pending of this.latexPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this.latexPending.clear();
    for (const p of this.agentPending.values()) {
      clearTimeout(p.timer);
      p.resolve(result);
    }
    this.agentPending.clear();
    for (const p of this.gitPending.values()) {
      clearTimeout(p.timer);
      p.resolve(result);
    }
    this.gitPending.clear();
    if (!result.ok) this.publish(result.error);
    return result;
  }

  start(): Promise<Result<ServiceStatus>> {
    if (this.startup) return this.startup;
    if (this.status.state === 'ready')
      return Promise.resolve({ ok: true, value: { ...this.status } });
    const generation = ++this.generation;
    this.status = { state: 'starting', pid: null, version: '0.1.0' };
    this.publish();
    const startup = new Promise<Result<ServiceStatus>>((resolve) => {
      this.startupResolve = resolve;
    });
    this.startup = startup;
    this.startupTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.unavailable('TIMEOUT', 'The local service did not start. Restart it to retry.');
    }, this.timeoutMs);
    try {
      const transport = this.spawn();
      this.transport = transport;
      transport.onMessage((message) => {
        if (generation !== this.generation || this.status.state === 'unavailable') return;
        const parsed = serviceMessageSchema.safeParse(message);
        if (!parsed.success) {
          this.unavailable(
            'INVALID_RESPONSE',
            'The local service sent an invalid response. Restart it to recover.',
          );
          return;
        }
        const data = parsed.data;
        if (data.type === 'project-closed') {
          this.projectLocation = null;
          return;
        }
        if (data.type === 'trash-project') {
          const pending = this.projectPending.get(data.id);
          if (!pending) {
            transport.postMessage({
              type: 'trash-project-result',
              id: data.id,
              error: 'The project operation expired before Trash began. Refresh and retry.',
            });
            return;
          }
          clearTimeout(pending.timer);
          pending.timer = setTimeout(
            () =>
              this.unavailable(
                'TIMEOUT',
                'System Trash did not finish. Restart Loom and inspect the folder before retrying.',
              ),
            300_000,
          );
          void Promise.resolve()
            .then(() => this.trashProject(data.path))
            .then(
              () => {
                if (generation === this.generation)
                  transport.postMessage({ type: 'trash-project-result', id: data.id, error: null });
              },
              () => {
                if (generation === this.generation)
                  transport.postMessage({
                    type: 'trash-project-result',
                    id: data.id,
                    error:
                      'Could not move this project to system Trash. Its library entry and recovery data have been retained.',
                  });
              },
            );
          return;
        }
        if (data.type === 'agent-result') {
          const p = this.agentPending.get(data.id);
          if (p) {
            clearTimeout(p.timer);
            this.agentPending.delete(data.id);
            p.resolve(data.result);
          }
          return;
        }
        if (data.type === 'git-result') {
          const pending = this.gitPending.get(data.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.gitPending.delete(data.id);
            pending.resolve(data.result);
          }
          return;
        }
        if (data.type === 'research-result') {
          const p = this.researchPending.get(data.id);
          if (p) {
            clearTimeout(p.timer);
            this.researchPending.delete(data.id);
            p.resolve(data.result);
          }
          return;
        }
        if (data.type === 'latex-result') {
          const pending = this.latexPending.get(data.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.latexPending.delete(data.id);
            pending.resolve(data.result);
          }
          return;
        }
        if (data.type === 'project-context') {
          this.projectLocation = { projectId: data.projectId, path: data.path };
          return;
        }
        if (data.type === 'project-result') {
          const pending = this.projectPending.get(data.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.projectPending.delete(data.id);
            pending.resolve(data.result);
          }
          return;
        }
        if (data.type === 'ready') {
          if (this.status.state !== 'starting') return;
          this.status = { state: 'ready', pid: data.pid, version: data.version };
          this.finishStartup({ ok: true, value: { ...this.status } });
          this.publish();
        } else {
          const pending = this.pending.get(data.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(data.id);
          pending.resolve({
            ok: true,
            value: { ...this.status, pid: data.pid, version: data.version },
          });
        }
      });
      transport.onExit(() => {
        if (generation !== this.generation || this.status.state === 'unavailable') return;
        this.unavailable(
          'SERVICE_UNAVAILABLE',
          'The local service stopped. Restart it to reconnect.',
          false,
        );
      });
      transport.onError(() => {
        if (generation !== this.generation || this.status.state === 'unavailable') return;
        this.unavailable(
          'SERVICE_UNAVAILABLE',
          'The local service encountered an error. Restart it to reconnect.',
        );
      });
    } catch {
      this.unavailable(
        'SERVICE_UNAVAILABLE',
        'The local service could not start. Restart it to retry.',
      );
    }
    return startup;
  }

  async getStatus(): Promise<Result<ServiceStatus>> {
    if (this.startup) return this.startup;
    if (this.status.state !== 'ready' || !this.transport)
      return { ok: true, value: { ...this.status } };
    if (this.pending.size >= 32)
      return failure('BUSY', 'Too many service checks are running. Try again shortly.');
    const id = `${this.generation}:${++this.nextId}`;
    return new Promise<Result<ServiceStatus>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(
          this.unavailable(
            'TIMEOUT',
            'The local service did not respond. Restart it to reconnect.',
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.transport!.postMessage({ type: 'ping', id });
      } catch {
        this.unavailable(
          'SERVICE_UNAVAILABLE',
          'The local service connection failed. Restart it to reconnect.',
        );
      }
    });
  }

  async project(command: unknown): Promise<ProjectResult> {
    const ready = await this.start();
    if (!ready.ok) return ready;
    if (this.projectPending.size >= 32) return failure('BUSY', 'Too many project operations.');
    const id = `${this.generation}:project:${++this.nextId}`;
    const clone =
      typeof command === 'object' &&
      command !== null &&
      'type' in command &&
      command.type === 'native-git-clone';
    if (clone) this.gitMutationsPending++;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.unavailable(
            'TIMEOUT',
            'Project operation interrupted. Restart the service and reopen the project to recover.',
          );
        },
        clone ? 300_000 : this.gitMutationsPending > 0 ? 300_000 : 30_000,
      );
      let settled = false;
      const complete = (result: ProjectResult) => {
        if (settled) return;
        settled = true;
        if (clone) this.gitMutationsPending--;
        resolve(result);
      };
      this.projectPending.set(id, { resolve: complete, timer });
      try {
        this.transport!.postMessage({ type: 'project', id, command });
      } catch {
        this.unavailable(
          'SERVICE_UNAVAILABLE',
          'Project connection interrupted. Restart to recover.',
        );
      }
    });
  }

  async research(command: ResearchCommand): Promise<ResearchResult> {
    const ready = await this.start();
    if (!ready.ok) return ready;
    if (this.researchPending.size >= 16)
      return failure('BUSY', 'Too many References requests. Try again shortly.');
    const id = `${this.generation}:research:${++this.nextId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.researchPending.delete(id);
        resolve(
          failure('TIMEOUT', 'References request timed out. Retry or reconnect the service.'),
        );
      }, 25000);
      this.researchPending.set(id, { resolve, timer });
      try {
        this.transport!.postMessage({ type: 'research', id, command });
      } catch {
        this.unavailable('SERVICE_UNAVAILABLE', 'References connection interrupted.');
      }
    });
  }
  async latex(command: LatexCommand): Promise<LatexResult> {
    const ready = await this.start();
    if (!ready.ok) return ready;
    if (this.latexPending.size >= 16)
      return failure('BUSY', 'Too many LaTeX requests. Try again shortly.');
    const id = `${this.generation}:latex:${++this.nextId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.latexPending.delete(id);
        resolve(failure('TIMEOUT', 'LaTeX request timed out. Retry or reconnect the service.'));
      }, 25000);
      this.latexPending.set(id, { resolve, timer });
      try {
        this.transport!.postMessage({ type: 'latex', id, command });
      } catch {
        this.unavailable('SERVICE_UNAVAILABLE', 'LaTeX connection interrupted.');
      }
    });
  }
  async git(command: GitCommand): Promise<GitResult> {
    const ready = await this.start();
    if (!ready.ok) return ready;
    if (this.gitPending.size >= 16) return failure('BUSY', 'Too many Git requests.');
    const mutation = ['stage', 'unstage', 'commit', 'pull', 'branch', 'resolve'].includes(
      command.type,
    );
    if (mutation) this.gitMutationsPending++;
    const id = `${this.generation}:git:${++this.nextId}`;
    return new Promise((resolve) => {
      let settled = false;
      const complete = (result: GitResult) => {
        if (settled) return;
        settled = true;
        if (mutation) this.gitMutationsPending--;
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.gitPending.delete(id);
        complete(
          failure('TIMEOUT', 'Git operation timed out. Refresh repository status before retrying.'),
        );
      }, 250_000);
      this.gitPending.set(id, { resolve: complete, timer });
      try {
        this.transport!.postMessage({ type: 'git', id, command });
      } catch {
        this.unavailable('SERVICE_UNAVAILABLE', 'Git connection interrupted.');
      }
    });
  }
  async agent(command: AgentCommand): Promise<AgentResult> {
    const ready = await this.start();
    if (!ready.ok) return ready;
    if (this.agentPending.size >= 16) return failure('BUSY', 'Too many agent requests.');
    const id = `${this.generation}:agent:${++this.nextId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.agentPending.delete(id);
        resolve(
          failure(
            'TIMEOUT',
            'Agent operation timed out. Reconnect and inspect the chat before retrying.',
          ),
        );
      }, 60000);
      this.agentPending.set(id, { resolve, timer });
      try {
        this.transport!.postMessage({ type: 'agent', id, command });
      } catch {
        this.unavailable('SERVICE_UNAVAILABLE', 'Agent connection interrupted.');
      }
    });
  }
  restart(): Promise<Result<ServiceStatus>> {
    if (this.startup) return this.startup;
    this.stop();
    return this.start();
  }

  stop(): void {
    this.unavailable('SERVICE_UNAVAILABLE', 'The local service connection was closed.');
  }
}
