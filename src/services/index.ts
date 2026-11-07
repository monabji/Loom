import { researchCommandSchema, researchResultSchema } from '../contracts/research';
import { ResearchService } from './research/service';
import { agentCommandSchema, agentResultSchema } from '../contracts/agent';
import { AgentService } from './agents/service';
import { latexCommandSchema, latexResultSchema, type LatexValue } from '../contracts/latex';
import { BuildService } from './latex/builds';
import { TexlabClient, projectStructure } from './latex/language';
import { join } from 'node:path';
import { serviceRequestSchema } from '../contracts/desktop';
import { projectCommandSchema } from '../contracts/project';
import { ProjectService } from './project/projects';
import { MetadataStore } from './project/store';
import { gitCommandSchema, gitResultSchema } from '../contracts/git';
import { cloneRepository, GitService } from './git/service';
import { sourceArchive, sourcePreflight } from './git/export';
import { z } from 'zod';
import { version as loomVersion } from '../../package.json';
let removingProject = false;
const trashResults = new Map<string, (error: string | null) => void>();
const trashResultSchema = z
  .object({ type: z.literal('trash-project-result'), id: z.string(), error: z.string().nullable() })
  .strict();
const port = process.parentPort;
if (!port) throw new Error('The Loom service requires a parent port.');
const projects = new ProjectService(new MetadataStore(process.argv[2]));
const builds = new BuildService(projects, join(process.argv[2], 'builds'));
const agents = new AgentService(projects, builds, process.argv[2]);
const research = new ResearchService(projects, () => agents.active());
// Restore unresolved activity before a native project switch can escape its guard.
const agentReady = agents.initialize().then(
  () => null,
  () =>
    'Agent recovery could not be initialized. Keep your application data and reopen with a compatible Loom version before changing papers or files.',
);
const agentRequest = z
  .object({ type: z.literal('agent'), id: z.string(), command: agentCommandSchema })
  .strict();
const language = new TexlabClient();
const latexRequest = z
  .object({ type: z.literal('latex'), id: z.string(), command: latexCommandSchema })
  .strict();
const gitRequest = z
  .object({ type: z.literal('git'), id: z.string(), command: gitCommandSchema })
  .strict();
let languageQueue: Promise<unknown> = Promise.resolve();
let gitMutating = false;
let gitMutationBarrier: Promise<void> = Promise.resolve();
let releaseGitMutation: (() => void) | undefined;

const native = z.union([
  z
    .object({
      type: z.literal('native-git-clone'),
      url: z.string().min(1).max(2000),
      destination: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ type: z.literal('native-main-folder'), projectId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal('native-import-image'),
      projectId: z.string().min(1),
      source: z.string().min(1).max(4096),
      path: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal('native-create-file'),
      path: z.string().min(1),
      projectId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.enum([
        'native-open',
        'native-create',
        'native-import-folder',
        'native-import-zip',
        'native-sample',
      ]),
      path: z.string().min(1),
      destination: z.string().optional(),
    })
    .strict(),
]);
const request = z
  .object({ type: z.literal('project'), id: z.string(), command: z.unknown() })
  .strict();
port.on('message', (event: { data: unknown }) => {
  const ping = serviceRequestSchema.safeParse(event.data);
  if (ping.success) {
    port.postMessage({ type: 'pong', id: ping.data.id, pid: process.pid, version: loomVersion });
    return;
  }
  const trashResult = trashResultSchema.safeParse(event.data);
  if (trashResult.success) {
    trashResults.get(trashResult.data.id)?.(trashResult.data.error);
    trashResults.delete(trashResult.data.id);
    return;
  }
  const incoming = z
    .object({ type: z.enum(['project', 'agent', 'latex', 'git', 'research']), id: z.string() })
    .passthrough()
    .safeParse(event.data);
  if (removingProject && incoming.success) {
    port.postMessage({
      type: `${incoming.data.type}-result`,
      id: incoming.data.id,
      result: {
        ok: false,
        error: {
          code: 'BUSY',
          message: 'A project is moving to Trash. Wait for it to finish.',
          retryable: true,
        },
      },
    });
    return;
  }
  const researchRequest = z
    .object({ type: z.literal('research'), id: z.string(), command: researchCommandSchema })
    .strict()
    .safeParse(event.data);
  if (researchRequest.success) {
    const { id, command } = researchRequest.data;
    void agentReady
      .then((error) => {
        if (error && command.type !== 'search' && command.type !== 'cancel') throw new Error(error);
        return research.command(command);
      })
      .then((value) =>
        port.postMessage({
          type: 'research-result',
          id,
          result: researchResultSchema.parse({ ok: true, value }),
        }),
      )
      .catch((error) =>
        port.postMessage({
          type: 'research-result',
          id,
          result: {
            ok: false,
            error: {
              code: 'RESEARCH_ERROR',
              message: error instanceof Error ? error.message : 'Reference operation failed.',
              retryable: true,
            },
          },
        }),
      );
    return;
  }
  const agent = agentRequest.safeParse(event.data);
  if (agent.success) {
    void agentReady
      .then((recoveryError) => {
        if (removingProject)
          throw new Error('A project is moving to Trash. Wait for it to finish.');
        if (gitMutating)
          throw new Error(
            'A Git operation is changing project files. Retry the agent request after it finishes.',
          );
        if (recoveryError) throw new Error(recoveryError);
        return agents.command(agent.data.command);
      })
      .then((value) =>
        port.postMessage({
          type: 'agent-result',
          id: agent.data.id,
          result: agentResultSchema.parse({ ok: true, value }),
        }),
      )
      .catch((error) =>
        port.postMessage({
          type: 'agent-result',
          id: agent.data.id,
          result: {
            ok: false,
            error: {
              code: 'AGENT_ERROR',
              message: error instanceof Error ? error.message : 'Agent operation failed.',
              retryable: true,
            },
          },
        }),
      );
    return;
  }
  const latex = latexRequest.safeParse(event.data);
  if (latex.success) {
    const { id, command } = latex.data;
    const execute = async () => {
      try {
        // Check project identity through the serialized boundary, then release it.
        const context = await projects.run(async () => {
          await projects.current();
          return projects.buildContext(command.projectId);
        });
        if (removingProject)
          throw new Error('A project is moving to Trash or closing. Wait for it to finish.');
        let value: LatexValue;
        if (command.type === 'status')
          value = { kind: 'state', state: await builds.status(command.projectId, command.detect) };
        else if (command.type === 'settings')
          value = {
            kind: 'state',
            state: await builds.settings(command.projectId, command.settings),
          };
        else if (command.type === 'build')
          value = { kind: 'state', state: builds.request(command.projectId, command.clean) };
        else if (command.type === 'cancel')
          value = { kind: 'state', state: builds.cancel(command.projectId) };
        else if (command.type === 'pdf')
          value = await builds.pdf(command.projectId, command.buildId);
        else if (command.type === 'forward' || command.type === 'reverse')
          value = await builds.mapping(command);
        else if (command.type === 'language') value = await language.execute(context, command);
        else value = { kind: 'structure', items: projectStructure(context) };
        port.postMessage({
          type: 'latex-result',
          id,
          result: latexResultSchema.parse({ ok: true, value }),
        });
      } catch (error) {
        port.postMessage({
          type: 'latex-result',
          id,
          result: {
            ok: false,
            error: {
              code: 'LATEX_ERROR',
              message: error instanceof Error ? error.message : 'LaTeX operation failed.',
              retryable: true,
            },
          },
        });
      }
    };
    if (command.type === 'language') {
      languageQueue = languageQueue.then(execute, execute);
    } else void execute();
    return;
  }
  const gitMessage = gitRequest.safeParse(event.data);
  if (gitMessage.success) {
    const { id, command } = gitMessage.data;
    const fileMutation =
      command.type === 'stage' ||
      command.type === 'unstage' ||
      command.type === 'commit' ||
      command.type === 'pull' ||
      command.type === 'branch' ||
      command.type === 'resolve';
    if (fileMutation && (gitMutating || agents.active())) {
      port.postMessage({
        type: 'git-result',
        id,
        result: {
          ok: false,
          error: {
            code: 'BUSY',
            message: gitMutating
              ? 'Another Git file operation is still running.'
              : 'Stop the active agent request before changing project files with Git.',
            retryable: true,
          },
        },
      });
      return;
    }
    if (fileMutation) {
      gitMutating = true;
      gitMutationBarrier = new Promise((resolve) => {
        releaseGitMutation = resolve;
      });
    }
    void (async () => {
      try {
        if (fileMutation) {
          const recoveryError = await agentReady;
          if (recoveryError) throw new Error(recoveryError);
          if (agents.active())
            throw new Error(
              'Stop the active agent request before changing the Git index or working tree.',
            );
        }
        if (command.type === 'preflight' || command.type === 'archive') {
          const captured = await projects.run(async () => {
            await projects.refresh();
            const before = projects.buildContext(command.projectId);
            const files = await projects.agentFiles(command.projectId);
            await projects.refresh();
            const after = projects.buildContext(command.projectId);
            if (before.snapshot.sourceRevision !== after.snapshot.sourceRevision)
              throw new Error(
                'Project files changed while preparing the export. Refresh the preflight and retry.',
              );
            return { files, revision: after.snapshot.sourceRevision ?? '' };
          });
          if (command.type === 'archive' && command.expectedRevision !== captured.revision)
            throw new Error(
              'Project files changed after preflight. Refresh the review before exporting.',
            );
          const value =
            command.type === 'preflight'
              ? sourcePreflight(captured.files, captured.revision)
              : sourceArchive(captured.files, captured.revision);
          port.postMessage({
            type: 'git-result',
            id,
            result: gitResultSchema.parse({ ok: true, value }),
          });
          return;
        }
        const context = await projects.run(async () => {
          await projects.current();
          const current = projects.buildContext(command.projectId);
          return {
            root: current.root,
            projectId: command.projectId,
            paths: current.files.map((file) => file.path),
          };
        });
        const executor = new GitService(() => context);
        let value = await executor.command(command);
        if (fileMutation) {
          const commitNotice = value.kind === 'status' ? value.commitNotice : null;
          const refreshed = await projects.run(async () => {
            await projects.refresh();
            const current = projects.buildContext(command.projectId);
            return {
              root: current.root,
              projectId: command.projectId,
              paths: current.files.map((file) => file.path),
            };
          });
          value = await new GitService(() => refreshed).command({
            type: 'status',
            projectId: command.projectId,
          });
          if (value.kind === 'status') value.commitNotice = commitNotice;
        }
        port.postMessage({
          type: 'git-result',
          id,
          result: (() => {
            const parsed = gitResultSchema.safeParse({ ok: true, value });
            if (parsed.success) return parsed.data;
            const sample =
              value.kind === 'status'
                ? value.files.slice(0, 5).map((file) => ({
                    path: file.path,
                    index: JSON.stringify(file.index),
                    worktree: JSON.stringify(file.worktree),
                  }))
                : { kind: value.kind };
            throw new Error(
              `Git returned a response outside its contract (${JSON.stringify(sample)}).`,
            );
          })(),
        });
      } catch (error) {
        if (fileMutation) {
          try {
            await projects.run(async () => {
              await projects.refresh();
            });
          } catch {
            /* Keep Git's worktree conflict and report both recovery paths through the next refresh. */
          }
        }
        port.postMessage({
          type: 'git-result',
          id,
          result: {
            ok: false,
            error: {
              code: 'GIT_ERROR',
              message:
                error instanceof Error ? error.message.slice(0, 500) : 'Git operation failed.',
              retryable: true,
            },
          },
        });
      } finally {
        if (fileMutation) {
          gitMutating = false;
          releaseGitMutation?.();
          releaseGitMutation = undefined;
        }
      }
    })().catch((error) => {
      port.postMessage({
        type: 'git-result',
        id,
        result: {
          ok: false,
          error: {
            code: 'GIT_ERROR',
            message: error instanceof Error ? error.message.slice(0, 500) : 'Git operation failed.',
            retryable: true,
          },
        },
      });
    });
    return;
  }
  const parsed = request.safeParse(event.data);
  if (!parsed.success) return;
  const clone = native.safeParse(parsed.data.command);
  if (clone.success && clone.data.type === 'native-git-clone') {
    const cloneRequest = clone.data;
    if (gitMutating || agents.active()) {
      port.postMessage({
        type: 'project-result',
        id: parsed.data.id,
        result: {
          ok: false,
          error: {
            code: 'BUSY',
            message: 'Finish the active agent or Git operation before opening the cloned project.',
            retryable: true,
          },
        },
      });
      return;
    }
    gitMutating = true;
    gitMutationBarrier = new Promise((resolve) => {
      releaseGitMutation = resolve;
    });
    void (async () => {
      try {
        const recoveryError = await agentReady;
        if (recoveryError) throw new Error(recoveryError);
        if (agents.active())
          throw new Error('Finish the active agent request before opening the cloned project.');
        await cloneRepository(cloneRequest.url, cloneRequest.destination);
        const value = await projects.run(() => projects.open(cloneRequest.destination));
        const location = projects.nativeLocation();
        if (location) port.postMessage({ type: 'project-context', ...location });
        port.postMessage({
          type: 'project-result',
          id: parsed.data.id,
          result: { ok: true, value },
        });
      } catch (error) {
        port.postMessage({
          type: 'project-result',
          id: parsed.data.id,
          result: {
            ok: false,
            error: {
              code: 'GIT_CLONE_FAILED',
              message:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : 'Git clone failed. Inspect any partial destination before retrying.',
              retryable: true,
            },
          },
        });
      } finally {
        gitMutating = false;
        releaseGitMutation?.();
        releaseGitMutation = undefined;
      }
    })();
    return;
  }
  void gitMutationBarrier
    .then(() => agentReady)
    .then((recoveryError) =>
      projects.run(async () => {
        try {
          const rawCommand = event.data as { command?: { type?: string } };
          if (
            recoveryError &&
            ![
              'current',
              'library',
              'load',
              'refresh',
              'search',
              'sync',
              'preferences',
              'preview-image',
            ].includes(rawCommand.command?.type ?? '')
          )
            throw new Error(recoveryError);
          if (
            agents.active() &&
            [
              'native-open',
              'reopen',
              'native-create',
              'native-import-folder',
              'native-import-zip',
              'native-sample',
              'native-main-folder',
              'import-image',
              'native-import-image',
              'rename',
              'delete',
              'restore',
            ].includes(rawCommand.command?.type ?? '')
          )
            throw new Error(
              'Stop the current agent request before changing papers or moving files.',
            );
          if (rawCommand.command?.type === 'library') {
            projectCommandSchema.parse(parsed.data.command);
            port.postMessage({
              type: 'project-result',
              id: parsed.data.id,
              result: { ok: true, value: null, library: await projects.library() },
            });
            return;
          }
          const removal = projectCommandSchema.safeParse(parsed.data.command);
          if (
            removal.success &&
            (removal.data.type === 'close-project' ||
              removal.data.type === 'trash-project' ||
              removal.data.type === 'forget-project')
          ) {
            if (agents.active() || gitMutating)
              throw new Error('Stop active agent and Git operations before removing a project.');
            removingProject = true;
            try {
              if (builds.active())
                throw new Error('Stop active builds before removing or closing a project.');
              if (agents.active() || gitMutating)
                throw new Error('Stop active agent and Git operations before removing a project.');
              if (removal.data.type === 'close-project') {
                await projects.closeProject(removal.data.projectId);
                language.dispose();
                port.postMessage({ type: 'project-closed' });
                port.postMessage({
                  type: 'project-result',
                  id: parsed.data.id,
                  result: { ok: true, value: null, library: await projects.library() },
                });
                return;
              }
              await projects.removeProject(
                removal.data.projectId,
                removal.data.type === 'trash-project' ? 'trash' : 'forget',
                (path) =>
                  new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                      trashResults.delete(parsed.data.id);
                      const error = new Error(
                        'System Trash did not reply. The library entry and recovery data are retained. Restart Loom and inspect the folder and Trash before retrying.',
                      );
                      error.name = 'TrashOutcomeUnknown';
                      reject(error);
                    }, 290_000);
                    trashResults.set(parsed.data.id, (error) => {
                      clearTimeout(timer);
                      error ? reject(new Error(error)) : resolve();
                    });
                    port.postMessage({ type: 'trash-project', id: parsed.data.id, path });
                  }),
              );
              port.postMessage({
                type: 'project-result',
                id: parsed.data.id,
                result: { ok: true, value: null, library: await projects.library() },
              });
            } finally {
              removingProject = false;
              trashResults.delete(parsed.data.id);
            }
            return;
          }
          const previousProject = projects.nativeLocation()?.projectId;
          const n = native.safeParse(parsed.data.command);
          let value;
          if (n.success) {
            const c = n.data;
            if (c.type === 'native-create-file')
              value = await projects.createFile(c.path!, c.projectId);
            else if (c.type === 'native-git-clone')
              throw new Error('Clone requests must use the native Git flow.');
            else if (c.type === 'native-import-image')
              value = await projects.importExternalImage(c.projectId, c.source, c.path);
            else if (c.type === 'native-main-folder')
              value = await projects.openMainFolder(c.projectId);
            else if (c.type === 'native-sample')
              value = await projects.openSample(c.path, c.destination!);
            else if (c.type === 'native-open') value = await projects.open(c.path);
            else if (c.type === 'native-create') value = await projects.create(c.path);
            else if (c.type === 'native-import-folder')
              value = await projects.importFolder(c.path, c.destination!);
            else value = await projects.importZip(c.path, c.destination!);
          } else value = await projects.command(projectCommandSchema.parse(parsed.data.command));
          const location = projects.nativeLocation();
          if (previousProject !== location?.projectId) language.dispose();
          if (location) port.postMessage({ type: 'project-context', ...location });
          port.postMessage({
            type: 'project-result',
            id: parsed.data.id,
            result: { ok: true, value },
          });
        } catch (error) {
          port.postMessage({
            type: 'project-result',
            id: parsed.data.id,
            result: {
              ok: false,
              error: {
                code: 'PROJECT_ERROR',
                message: error instanceof Error ? error.message : 'Project operation failed.',
                retryable: true,
              },
            },
          });
        }
      }),
    );
});
port.postMessage({ type: 'ready', pid: process.pid, version: loomVersion });
