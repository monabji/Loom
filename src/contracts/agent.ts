import { z } from 'zod';
import { relativePath } from './project';
import { diagnosticSchema } from './latex';
export const harnessSchema = z.enum(['opencode', 'codex']);
export type HarnessKind = z.infer<typeof harnessSchema>;
const id = z.string().min(1).max(160);
export const agentSettingsSchema = z
  .object({
    permissionMode: z.enum(['supervised', 'auto-accept-edits', 'auto', 'full-access']),
    reasoning: z.string().max(100),
  })
  .strict();
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export const defaultAgentSettings = (): AgentSettings => ({
  permissionMode: 'auto-accept-edits',
  reasoning: '',
});
export const agentModelSchema = z
  .object({
    id,
    providerId: id,
    name: z.string().max(300),
    images: z.boolean(),
    tools: z.boolean(),
    reasoningEfforts: z.array(z.string().max(100)).max(30).optional(),
    defaultReasoning: z.string().max(100).optional(),
  })
  .strict();
export type AgentModel = z.infer<typeof agentModelSchema>;
export const agentMessageSchema = z
  .object({
    id,
    harness: harnessSchema.optional(),
    role: z.enum(['user', 'assistant', 'tool', 'status']),
    text: z.string().max(100000),
    state: z.string().max(100),
    execution: z
      .object({
        command: z.string().max(8000),
        output: z.string().max(20000).nullable(),
        exitCode: z.number().int().nullable(),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export const agentPermissionSchema = z
  .object({ id, action: z.string().max(300), resources: z.array(z.string().max(3000)).max(100) })
  .strict();
const fieldSchema = z
  .object({
    key: id,
    title: z.string().max(1000),
    description: z.string().max(3000),
    type: z.enum(['string', 'multiselect', 'boolean', 'number', 'integer', 'external']),
    required: z.boolean(),
    options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).max(100),
  })
  .strict();
export const agentQuestionSchema = z
  .object({
    id,
    title: z.string().max(1000),
    fields: z.array(fieldSchema).max(100),
    rejectable: z.boolean().optional(),
  })
  .strict();
export const agentChangeSchema = z
  .object({
    path: relativePath,
    before: z.string().max(200000).nullable(),
    after: z.string().max(200000).nullable(),
    kind: z.enum(['created', 'modified', 'deleted']),
    binary: z.boolean(),
    review: z.enum(['pending', 'kept', 'reverted']),
    humanTouched: z.boolean(),
    diffLimited: z.boolean().optional(),
    diff: z
      .array(
        z
          .object({ text: z.string().max(200000), kind: z.enum(['same', 'added', 'removed']) })
          .strict(),
      )
      .max(5000)
      .optional(),
  })
  .strict();
export type AgentChange = z.infer<typeof agentChangeSchema>;
export const agentTurnSchema = z
  .object({
    id,
    sessionId: id,
    status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    startedAt: z.string(),
    revision: z.string(),
    resultRevision: z.string().max(100).optional(),
    conversationId: id.optional(),
    messageId: id.optional(),
    messageAssociationResolved: z.boolean().optional(),
    attachments: z.array(relativePath).max(20).optional(),
    images: z
      .array(z.object({ path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .max(20)
      .optional(),
    changes: z.array(agentChangeSchema).max(2000),
  })
  .strict();
export type AgentTurn = z.infer<typeof agentTurnSchema>;
export const agentStateSchema = z
  .object({
    projectId: id,
    harness: harnessSchema,
    providers: z
      .array(
        z
          .object({
            id: harnessSchema,
            installed: z.boolean(),
            version: z.string(),
            auth: z.enum(['available', 'required', 'unknown']),
            executable: z.string().max(4096).optional(),
            connected: z.boolean().optional(),
          })
          .strict(),
      )
      .max(2),
    connection: z.enum(['disconnected', 'connected', 'interrupted']),
    installed: z.boolean(),
    version: z.string().max(100),
    ownership: z.enum(['loom', 'external']).nullable(),
    models: z.array(agentModelSchema).max(3000),
    sessions: z
      .array(
        z
          .object({
            id,
            harness: harnessSchema,
            title: z.string().max(300),
            settings: agentSettingsSchema.optional(),
            harnesses: z.array(harnessSchema).max(2).optional(),
          })
          .strict(),
      )
      .max(100),
    sessionId: id.nullable(),
    sessionUnavailable: z.boolean().optional(),
    restore: z
      .object({
        sessionId: id,
        reason: z.enum(['missing', 'retryable', 'auth', 'folder-mismatch']),
        message: z.string().max(2000),
      })
      .strict()
      .optional(),
    settings: agentSettingsSchema,
    messages: z.array(agentMessageSchema).max(200),
    permissions: z.array(agentPermissionSchema).max(100),
    questions: z.array(agentQuestionSchema).max(100),
    turns: z.array(agentTurnSchema).max(100),
    running: z.boolean(),
    error: z.string().max(2000),
    toolsAvailable: z.boolean(),
    saveRequest: z.object({ id }).strict().optional(),
    imagePreview: z
      .object({
        path: relativePath,
        mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
        data: z.string().max(14_000_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentState = z.infer<typeof agentStateSchema>;
export const agentWorkspaceContextSchema = z
  .object({
    activeFile: relativePath.optional(),
    errors: z
      .array(
        z
          .object({
            source: z.enum(['editor', 'pdf', 'agent', 'service']),
            message: z.string().max(2000),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    editorDiagnostics: z
      .object({ revision: z.string().max(100), items: z.array(diagnosticSchema).max(20) })
      .strict()
      .optional(),
  })
  .strict();
export type AgentWorkspaceContext = z.infer<typeof agentWorkspaceContextSchema>;
export const agentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), projectId: id, detect: z.boolean().optional() }).strict(),
  z
    .object({
      type: z.literal('connect'),
      projectId: id,
      harness: harnessSchema,
      endpoint: z.string().max(300).optional(),
      username: z.string().max(100).optional(),
      password: z.string().max(1000).optional(),
      executable: z.string().max(4096).optional(),
    })
    .strict(),
  z.object({ type: z.literal('disconnect'), projectId: id }).strict(),
  z.object({ type: z.literal('delete-session'), projectId: id, sessionId: id }).strict(),
  z
    .object({
      type: z.literal('rename-session'),
      projectId: id,
      sessionId: id,
      title: z.string().trim().min(1).max(300),
    })
    .strict(),
  z.object({ type: z.literal('session'), projectId: id, sessionId: id.optional() }).strict(),
  z.object({ type: z.literal('retry-session'), projectId: id, sessionId: id }).strict(),
  z.object({ type: z.literal('recover-session'), projectId: id, sessionId: id }).strict(),
  z
    .object({
      type: z.literal('send'),
      projectId: id,
      sessionId: id,
      prompt: z.string().min(1).max(50000),
      model: agentModelSchema,
      attachments: z.array(relativePath).max(20),
      selection: z
        .object({ path: relativePath, text: z.string().max(50000) })
        .strict()
        .nullable(),
      revision: z.string().min(1).max(100),
      workspaceContext: agentWorkspaceContextSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('settings'), projectId: id, settings: agentSettingsSchema }).strict(),
  z
    .object({
      type: z.literal('save-result'),
      projectId: id,
      requestId: id,
      saved: z.boolean(),
      revision: z.string().max(100).optional(),
    })
    .strict(),
  z.object({ type: z.literal('cancel'), projectId: id }).strict(),
  z
    .object({
      type: z.literal('preview-submitted-image'),
      projectId: id,
      turnId: id,
      path: relativePath,
    })
    .strict(),
  z
    .object({
      type: z.literal('permission'),
      projectId: id,
      requestId: id,
      reply: z.enum(['once', 'reject']),
    })
    .strict(),
  z
    .object({
      type: z.literal('answer'),
      reject: z.boolean().optional(),
      projectId: id,
      requestId: id,
      answer: z.record(
        z.string(),
        z.union([
          z.string().max(10000),
          z.array(z.string().max(1000)).max(100),
          z.number().finite(),
          z.boolean(),
        ]),
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('review'),
      projectId: id,
      turnId: id,
      path: relativePath,
      action: z.enum(['keep', 'revert']),
      revision: z.string().min(1).max(100),
    })
    .strict(),
]);
export type AgentCommand = z.infer<typeof agentCommandSchema>;
export const agentResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: agentStateSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict(),
    })
    .strict(),
]);
export type AgentResult = z.infer<typeof agentResultSchema>;
