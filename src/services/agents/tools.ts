import { createServer, type Server } from 'node:http';
import { version as loomVersion } from '../../../package.json';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { relativePath } from '../../contracts/project';
import { ProjectService } from '../project/projects';
import { BuildService } from '../latex/builds';
import { projectStructure } from '../latex/language';
import { diagnosticContext } from './diagnostic-context';
const rpc = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const paperPath = relativePath.refine(
  (path) => !path.split('/').some((part) => part === '.git' || part.startsWith('.loom-save-')),
  'Project internals are not paper files.',
);
const toolInput = z.discriminatedUnion('name', [
  z
    .object({
      name: z.enum([
        'paper_structure',
        'pdf_status',
        'paper_diagnostics',
        'build_pdf',
        'paper_files',
        'paper_save',
      ]),
      arguments: z.object({}).strict().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal('paper_create_file'),
      arguments: z
        .object({
          path: paperPath,
          text: z
            .string()
            .max(16000)
            .refine((text) => !text.includes('\0'))
            .default(''),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal('paper_move_file'),
      arguments: z.object({ path: paperPath, destination: paperPath }).strict(),
    })
    .strict(),
  z
    .object({
      name: z.enum(['paper_delete_file', 'paper_set_main']),
      arguments: z.object({ path: paperPath }).strict(),
    })
    .strict(),
]);
const pathProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  description: 'Project-relative path; no traversal, symbolic links or Git internals.',
};
/** Small stateless Streamable HTTP MCP surface; never an agent execution loop. */
export class AgentTools {
  private server: Server | null = null;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  readonly token = randomBytes(32).toString('hex');
  url = '';
  constructor(
    private projects: ProjectService,
    private builds: BuildService,
    private projectId: string,
    private workspace?: { save: () => Promise<string>; canMutate: () => boolean },
  ) {}
  private async callTool(input: z.infer<typeof toolInput>) {
    const mutates = [
      'paper_save',
      'paper_create_file',
      'paper_move_file',
      'paper_delete_file',
      'paper_set_main',
    ].includes(input.name);
    const perform = async () => {
      if (mutates) {
        if (!this.workspace?.canMutate())
          throw new Error('File operations require an active checkpointed Loom agent request.');
        await this.workspace.save();
        if (!this.workspace.canMutate())
          throw new Error('The agent request stopped before the paper operation.');
      }
      if (input.name === 'paper_diagnostics') {
        const state = await this.builds.status(this.projectId);
        return this.projects.run(async () => {
          await this.projects.refresh();
          return diagnosticContext(this.projects.buildContext(this.projectId), state);
        });
      }
      if (input.name === 'pdf_status') {
        await this.projects.run(async () => {
          this.projects.buildContext(this.projectId);
        });
        return this.builds.status(this.projectId);
      }
      return this.projects.run(async () => {
        if (mutates && !this.workspace?.canMutate())
          throw new Error('The agent request stopped before the paper operation.');
        await this.projects.refresh();
        let context = this.projects.buildContext(this.projectId);
        if (
          (mutates || input.name === 'build_pdf') &&
          context.snapshot.files.some((file) => !file.deleted && (!file.saved || file.conflict))
        )
          throw new Error('Save or resolve the paper before changing files or building.');
        if (input.name === 'paper_structure') return projectStructure(context);
        if (input.name === 'build_pdf') return this.builds.request(this.projectId, false);
        if (input.name === 'paper_create_file')
          await this.projects.agentCreateFile(
            this.projectId,
            input.arguments.path,
            input.arguments.text,
          );
        if (input.name === 'paper_set_main')
          await this.projects.agentSetRoot(this.projectId, input.arguments.path);
        if (input.name === 'paper_move_file' || input.name === 'paper_delete_file') {
          const file = context.snapshot.files.find(
            (file) => !file.deleted && file.path === input.arguments.path,
          );
          if (!file) throw new Error('This file is no longer in the paper.');
          await this.projects.command(
            input.name === 'paper_move_file'
              ? { type: 'rename', fileId: file.id, path: input.arguments.destination }
              : { type: 'delete', fileId: file.id },
          );
          if (input.name === 'paper_move_file' && file.id === context.snapshot.rootId)
            await this.projects.agentSetRoot(this.projectId, input.arguments.destination);
        }
        await this.projects.refresh();
        context = this.projects.buildContext(this.projectId);
        return {
          saved: context.snapshot.files.every(
            (file) => file.deleted || (file.saved && !file.conflict),
          ),
          revision: context.snapshot.sourceRevision,
          mainDocument:
            context.files.find((file) => file.id === context.snapshot.rootId)?.path ?? null,
          mainCandidates: context.files
            .filter(
              (file) =>
                file.diskKind === 'text' && /\\documentclass(?:\s|\[|\{)/.test(file.text ?? ''),
            )
            .map((file) => file.path),
          files: context.snapshot.files
            .filter((file) => !file.deleted)
            .map(({ path, diskKind, saved, conflict }) => ({ path, diskKind, saved, conflict })),
          ...(input.name === 'paper_delete_file'
            ? {
                deleted: input.arguments.path,
                recovery:
                  'Retained in Loom recovery; native agent turn review also retains its pre-turn copy.',
              }
            : {}),
        };
      });
    };
    if (!mutates) return perform();
    const next = this.mutationQueue.then(perform);
    this.mutationQueue = next.catch(() => {});
    return next;
  }
  async start() {
    this.server = createServer(async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? ''),
        expected = Buffer.from('Bearer ' + this.token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected) ||
        req.url !== '/mcp'
      ) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      let callId: string | number | undefined;
      let toolCall = false;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) throw new Error('Request too large.');
          chunks.push(chunk);
        }
        const call = rpc.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        callId = call.id;
        toolCall = call.method === 'tools/call';
        if (call.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        let result: unknown;
        if (call.method === 'initialize')
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'loom-paper', version: loomVersion },
          };
        else if (call.method === 'ping') result = {};
        else if (call.method === 'tools/list')
          result = {
            tools: [
              {
                name: 'paper_structure',
                description: 'Inspect sections and source locations in the open paper.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
              {
                name: 'paper_diagnostics',
                description:
                  'Read current PDF errors, warnings, build log excerpts, source locations and current saved-source excerpts. Labels stale builds; does not start a build or modify files.',
                annotations: { readOnlyHint: true },
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
              {
                name: 'pdf_status',
                description:
                  'Inspect Loom saved-source build revision, status and diagnostics. Does not execute a build.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
              {
                name: 'paper_files',
                description:
                  'List current project files, the assigned main .tex file and documentclass candidates. A unique candidate is detected automatically; ambiguous candidates need paper_set_main.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
              {
                name: 'paper_save',
                description:
                  'Ask the live Loom editor to save current author text and confirm its saved revision. Requires the editor to acknowledge; never reports an unconfirmed save.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
              {
                name: 'paper_create_file',
                description:
                  'Create a new UTF-8 file, including parent folders, without overwriting existing bytes. Saves current author work first; the turn checkpoint and change review remain available.',
                inputSchema: {
                  type: 'object',
                  properties: { path: pathProperty, text: { type: 'string', maxLength: 16000 } },
                  required: ['path'],
                  additionalProperties: false,
                },
              },
              {
                name: 'paper_move_file',
                description:
                  'Move or rename one paper file into a folder, preserving its editor identity. Updates portable main-document configuration when moving the main .tex file. Update any manuscript include/asset references separately.',
                inputSchema: {
                  type: 'object',
                  properties: { path: pathProperty, destination: pathProperty },
                  required: ['path', 'destination'],
                  additionalProperties: false,
                },
              },
              {
                name: 'paper_delete_file',
                description:
                  'Delete a paper file with a recoverable local copy after saving current author work. Requires an active checkpointed agent request. Does not operate on Git or outside the paper.',
                annotations: { destructiveHint: true },
                inputSchema: {
                  type: 'object',
                  properties: { path: pathProperty },
                  required: ['path'],
                  additionalProperties: false,
                },
              },
              {
                name: 'paper_set_main',
                description:
                  'Assign the .tex entry point and save its portable build configuration. Use when the paper has multiple documentclass candidates or the author requests a different main document.',
                inputSchema: {
                  type: 'object',
                  properties: { path: pathProperty },
                  required: ['path'],
                  additionalProperties: false,
                },
              },
              {
                name: 'build_pdf',
                description:
                  'Schedule a PDF build through Loom from saved source; returns build identity/status. Poll pdf_status to inspect actual completion. Unsaved author text is excluded until saved.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
          };
        else if (call.method === 'tools/call') {
          const p = toolInput.parse(call.params);
          const value = await this.callTool(p);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: call.id,
              error: { code: -32601, message: 'Unknown tool method.' },
            }),
          );
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
      } catch (error) {
        const message =
          error instanceof z.ZodError
            ? 'Invalid tool arguments. Use the tool’s published input schema and project-relative paper paths; shell commands and project internals are not accepted.'
            : error instanceof Error
              ? error.message.slice(0, 1000)
              : 'The paper tool could not complete. Check saved source and PDF diagnostics.';
        res
          .writeHead(toolCall && callId !== undefined ? 200 : 400, {
            'Content-Type': 'application/json',
          })
          .end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: callId ?? null,
              ...(toolCall && callId !== undefined
                ? { result: { isError: true, content: [{ type: 'text', text: message }] } }
                : { error: { code: -32602, message } }),
            }),
          );
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Paper tools could not start.');
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    return this;
  }
  async close() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = null;
  }
}
