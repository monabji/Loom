import { researchResultSchema, type ResearchCommand, type ResearchResult } from './research';
import { agentResultSchema, type AgentCommand, type AgentResult } from './agent';
import { latexResultSchema, type LatexCommand, type LatexResult } from './latex';
import {
  projectResultSchema,
  relativePath,
  type ProjectChoice,
  type ChooseFileRequest,
  type ProjectCommand,
  type ProjectResult,
} from './project';
import { z } from 'zod';
import { gitResultSchema, type GitCommand, type GitResult } from './git';
import { sourceExportResultSchema, type SourceExportRequest } from './git';

export const channels = {
  closeRequest: 'loom:window:close-request',
  closeReady: 'loom:window:close-ready',
  status: 'loom:service:status',
  restart: 'loom:service:restart',
  event: 'loom:service:event',
  project: 'loom:project:command',
  chooseProject: 'loom:project:choose',
  chooseFile: 'loom:project:choose-file',
  chooseAttachments: 'loom:agent:choose-attachments',
  agent: 'loom:agent:command',
  research: 'loom:research:command',
  openSource: 'loom:research:open-source',
  latex: 'loom:latex:command',
  git: 'loom:git:command',
  cloneGit: 'loom:git:clone',
  exportSource: 'loom:source:export',
  setup: 'loom:latex:setup',
  exportPdf: 'loom:latex:export',
} as const;

export const operationErrorSchema = z
  .object({
    code: z.enum([
      'INVALID_REQUEST',
      'FORBIDDEN',
      'SERVICE_UNAVAILABLE',
      'TIMEOUT',
      'INVALID_RESPONSE',
      'BUSY',
    ]),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
  })
  .strict();
export type OperationError = z.infer<typeof operationErrorSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: OperationError };

export const serviceStatusSchema = z
  .object({
    state: z.enum(['ready', 'starting', 'unavailable']),
    pid: z.number().int().positive().nullable(),
    version: z.string().min(1).max(80),
  })
  .strict()
  .refine((status) => (status.state === 'ready') === (status.pid !== null), {
    message: 'Only a ready service has a process ID.',
  });
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export const statusResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: serviceStatusSchema }).strict(),
  z.object({ ok: z.literal(false), error: operationErrorSchema }).strict(),
]);
export const serviceEventSchema = z
  .object({
    type: z.literal('service-status'),
    status: serviceStatusSchema,
    error: operationErrorSchema.optional(),
  })
  .strict();
export type ServiceEvent = z.infer<typeof serviceEventSchema>;

// No project paths, file access, shell execution, or arbitrary IPC are exposed.
export const attachmentChoiceSchema = z
  .object({
    projectId: z.string().min(1).max(160),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();
export const attachmentResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      value: z
        .object({
          cancelled: z.boolean(),
          paths: z.array(relativePath).max(20),
          imported: z.number().int().min(0).max(20).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: operationErrorSchema }).strict(),
]);
export interface LoomDesktop {
  research(command: ResearchCommand): Promise<ResearchResult>;
  openSource(url: string): Promise<void>;
  agent(command: AgentCommand): Promise<AgentResult>;
  openSetup(guide: 'tex' | 'texlab' | 'opencode' | 'codex'): Promise<void>;
  latex(command: LatexCommand): Promise<LatexResult>;
  git(command: GitCommand): Promise<GitResult>;
  cloneGit(request: { url: string }): Promise<ProjectResult>;
  exportSource(request: SourceExportRequest): Promise<z.infer<typeof sourceExportResultSchema>>;
  exportPdf(request: { projectId: string; buildId: string; stale: boolean }): Promise<LatexResult>;
  chooseAttachments(request: {
    projectId: string;
    limit?: number;
  }): Promise<z.infer<typeof attachmentResultSchema>>;
  chooseFile(request: ChooseFileRequest): Promise<ProjectResult>;
  project(command: ProjectCommand): Promise<ProjectResult>;
  chooseProject(choice: ProjectChoice): Promise<ProjectResult>;
  onCloseRequest(listener: () => void): () => void;
  completeClose(): Promise<void>;
  getStatus(): Promise<Result<ServiceStatus>>;
  restartService(): Promise<Result<ServiceStatus>>;
  onServiceEvent(listener: (event: ServiceEvent) => void): () => void;
}

export const emptyRequestSchema = z.object({}).strict();
export const serviceRequestSchema = z
  .object({
    type: z.literal('ping'),
    id: z.string().min(1).max(80),
  })
  .strict();
export const serviceMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project-closed') }).strict(),
  z
    .object({ type: z.literal('trash-project'), id: z.string(), path: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({ type: z.literal('research-result'), id: z.string(), result: researchResultSchema })
    .strict(),
  z.object({ type: z.literal('agent-result'), id: z.string(), result: agentResultSchema }).strict(),
  z.object({ type: z.literal('latex-result'), id: z.string(), result: latexResultSchema }).strict(),
  z.object({ type: z.literal('git-result'), id: z.string(), result: gitResultSchema }).strict(),
  z
    .object({ type: z.literal('project-context'), projectId: z.string(), path: z.string() })
    .strict(),
  z
    .object({ type: z.literal('project-result'), id: z.string(), result: projectResultSchema })
    .strict(),
  z
    .object({
      type: z.literal('ready'),
      pid: z.number().int().positive(),
      version: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      type: z.literal('pong'),
      id: z.string().min(1).max(80),
      pid: z.number().int().positive(),
      version: z.string().min(1).max(80),
    })
    .strict(),
]);
export type ServiceMessage = z.infer<typeof serviceMessageSchema>;

export function failure(
  code: OperationError['code'],
  message: string,
  retryable = true,
): Result<never> {
  return { ok: false, error: { code, message, retryable } };
}
