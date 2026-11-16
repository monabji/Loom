import { syncDirectory } from '../../domain/sync-directory';
import { diffLines } from 'diff';
import { z } from 'zod';
import { agentTurnSchema } from '../../contracts/agent';
import { relativePath } from '../../contracts/project';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, posix } from 'node:path';
import type { AgentTurn, AgentChange } from '../../contracts/agent';
import { ProjectService } from '../project/projects';
import { reconcile } from '../project/reconcile';
import { imageMime } from '../../domain/images';
import { imageBytesMatch } from './images';

type RecordTurn = {
  view: AgentTurn;
  knownMessageIds?: string[];
  before: Record<string, string>;
  after: Record<string, string>;
  human: string[];
  unsettled?: boolean;
  external?: boolean;
  supervisorPid?: number;
};
export function decodeText(bytes: Buffer | null): string | null {
  if (!bytes) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}
/** Durable checkpoints precede submission; snapshots are protected app data, never project files. */
export class AgentChanges {
  private turns: RecordTurn[] = [];
  private projectId = '';
  constructor(
    private projects: ProjectService,
    private directory: string,
  ) {
    projects.onHumanWrite = (path) => {
      const turn = this.turns.find((t) => t.view.status === 'running');
      if (turn && !turn.human.includes(path)) {
        turn.human.push(path);
        this.persist();
      }
    };
  }
  async bind(projectId: string) {
    if (projectId === this.projectId) return;
    const raw = JSON.parse(
      this.projects.store.get(`agent-turns:${projectId}`) ?? '{"version":1,"turns":[]}',
    );
    const record = z
      .object({
        version: z.literal(1),
        turns: z
          .array(
            z
              .object({
                view: agentTurnSchema,
                knownMessageIds: z.array(z.string().min(1).max(160)).max(200).optional(),
                before: z.record(relativePath, relativePath),
                after: z.record(relativePath, relativePath),
                human: z.array(relativePath),
                unsettled: z.boolean().optional(),
                external: z.boolean().optional(),
                supervisorPid: z.number().int().positive().optional(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict();
    // One explicit migration for the initial Phase 4 development array format.
    const parsed = record.safeParse(Array.isArray(raw) ? { version: 1, turns: raw } : raw);
    if (!parsed.success)
      throw new Error(
        'Agent recovery metadata is incompatible. Keep application data and use a compatible Loom version.',
      );
    this.projectId = projectId;
    this.turns = parsed.data.turns;
    for (const turn of this.turns)
      if (turn.view.status === 'running') turn.view.status = 'interrupted';
    this.persist();
  }
  private persist() {
    this.projects.store.set(
      `agent-turns:${this.projectId}`,
      JSON.stringify({ version: 1, turns: this.turns }),
    );
  }
  views() {
    return this.turns.map((t) => t.view);
  }
  running() {
    return this.turns.find((t) => t.view.status === 'running');
  }
  private async checkpoint(id: string, name: string, files: Map<string, Buffer>) {
    const folder = join(this.directory, id, name);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const index: Record<string, string> = {};
    for (const [path, bytes] of files) {
      const mime = imageMime(path);
      const extension = mime ? '.' + path.split('.').pop()!.toLowerCase() : '';
      const key = randomUUID() + extension;
      const handle = await fs.open(join(folder, key), 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        if (mime) await handle.chmod(0o400);
      } finally {
        await handle.close();
      }
      index[path] = posix.join(id, name, key);
    }
    await syncDirectory(folder);
    return index;
  }
  async begin(
    sessionId: string,
    revision: string,
    external = false,
    supervisorPid?: number,
    conversationId?: string,
    imagePaths: string[] = [],
    knownMessageIds: string[] = [],
    attachmentPaths: string[] = imagePaths,
  ) {
    if (this.unsettled()) throw new Error('Recover the previous request before starting another.');
    if (!external && (!supervisorPid || !Number.isSafeInteger(supervisorPid) || supervisorPid <= 1))
      throw new Error('The agent process cannot be tracked safely. Reconnect before sending.');
    if (this.turns.length >= 100)
      throw new Error(
        'This pilot retains up to 100 turns per paper. Recovery copies are retained.',
      );
    const context = this.projects.buildContext(this.projectId);
    if (
      context.snapshot.sourceRevision !== revision ||
      context.snapshot.files.some((f) => !f.deleted && (!f.saved || f.conflict))
    )
      throw new Error('Your paper changed while preparing the request. Save and try again.');
    const files = await this.projects.agentFiles(this.projectId);
    const attachments = [...new Set([...attachmentPaths, ...imagePaths])];
    if (attachments.length > 20 || attachments.some((path) => !files.has(path)))
      throw new Error('An attached file is unavailable. Attach it again.');
    const images = imagePaths.map((path) => {
      const bytes = files.get(path),
        mime = imageMime(path);
      if (!bytes || !mime || bytes.length > 10 * 1024 * 1024 || !imageBytesMatch(mime, bytes))
        throw new Error('An attached image changed while preparing the request. Attach it again.');
      return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    if (this.projects.snapshot().sourceRevision !== revision)
      throw new Error('Your paper changed while preparing the request. Try again.');
    const id = randomUUID();
    const before = await this.checkpoint(id, 'before', files);
    const latest = await this.projects.agentFiles(this.projectId);
    if (
      latest.size !== files.size ||
      [...latest].some(([path, bytes]) => !files.get(path)?.equals(bytes))
    )
      throw new Error('The paper changed while preparing recovery. Try again.');
    const turn: RecordTurn = {
      view: {
        id,
        sessionId,
        status: 'running',
        startedAt: new Date().toISOString(),
        revision,
        ...(conversationId ? { conversationId, images, attachments } : {}),
        changes: [],
      },
      ...(attachments.length ? { knownMessageIds: knownMessageIds.slice(-200) } : {}),
      before,
      after: {},
      human: [],
      unsettled: true,
      external,
      supervisorPid,
    };
    this.turns.unshift(turn);
    this.persist();
    return turn;
  }
  linkSubmittedAttachments(messages: { id: string; role: string }[], sessionId: string) {
    const unlinked = this.turns
      .filter(
        (turn) =>
          turn.view.sessionId === sessionId &&
          (turn.view.attachments?.length || turn.view.images?.length) &&
          turn.knownMessageIds !== undefined &&
          !turn.view.messageAssociationResolved &&
          !turn.view.messageId,
      )
      .sort((a, b) => b.view.startedAt.localeCompare(a.view.startedAt));
    const used = new Set(
      this.turns.flatMap((turn) => (turn.view.messageId ? [turn.view.messageId] : [])),
    );
    let changed = false;
    for (const turn of unlinked) {
      const message = [...messages]
        .reverse()
        .find(
          (candidate) =>
            candidate.role === 'user' &&
            !used.has(candidate.id) &&
            !turn.knownMessageIds?.includes(candidate.id),
        );
      if (!message) continue;
      turn.view.messageId = message.id;
      turn.view.messageAssociationResolved = true;
      used.add(message.id);
      changed = true;
    }
    if (changed) this.persist();
  }
  imagePath(turn: RecordTurn, path: string) {
    if (!turn.view.images?.some((image) => image.path === path) || !turn.before[path])
      throw new Error('The submitted image is unavailable.');
    return join(this.directory, turn.before[path]);
  }
  async submittedImage(turnId: string, path: string, conversationId: string) {
    const turn = this.turns.find(
      (item) => item.view.id === turnId && item.view.conversationId === conversationId,
    );
    const image = turn?.view.images?.find((item) => item.path === path);
    const mime = imageMime(path);
    if (!turn || !image || !mime)
      throw new Error('The submitted image is unavailable in this conversation.');
    const handle = await fs.open(this.imagePath(turn, path), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024)
        throw new Error('The saved image is unavailable.');
      const bytes = Buffer.alloc(stat.size);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (
        read.bytesRead !== bytes.length ||
        !imageBytesMatch(mime, bytes) ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256
      )
        throw new Error('The saved submitted image changed and cannot be verified.');
      return {
        path,
        mime: mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: bytes.toString('base64'),
      };
    } finally {
      await handle.close();
    }
  }
  private comparison(
    before: string | null,
    after: string | null,
    previous?: AgentChange,
  ): Pick<AgentChange, 'diff' | 'diffLimited'> {
    if (previous?.diff) return { diff: previous.diff, diffLimited: previous.diffLimited };
    const a = before?.slice(0, 200000) ?? '',
      b = after?.slice(0, 200000) ?? '';
    const parts = diffLines(a, b, { timeout: 20, maxEditLength: 1000 });
    return {
      diffLimited:
        !parts || (!!before && before.length > 200000) || (!!after && after.length > 200000),
      diff: parts
        ? parts.slice(0, 5000).map((part) => ({
            text: part.value,
            kind: part.added
              ? ('added' as const)
              : part.removed
                ? ('removed' as const)
                : ('same' as const),
          }))
        : [
            { text: a, kind: 'removed' },
            { text: b, kind: 'added' },
          ],
    };
  }
  async observe(turn = this.running()) {
    if (!turn) return;
    const files = await this.projects.agentFiles(this.projectId);
    // Checkpoint each observed state before publishing it. Existing copies remain recoverable.
    const next: Record<string, string> = {};
    const changes: AgentChange[] = [];
    for (const path of new Set([...Object.keys(turn.before), ...files.keys()])) {
      const before = turn.before[path]
        ? await fs.readFile(join(this.directory, turn.before[path]))
        : null;
      const after = files.get(path) ?? null;
      if ((before === null && after === null) || (before && after && before.equals(after)))
        continue;
      if (after) {
        const previous = turn.after[path];
        if (previous && (await fs.readFile(join(this.directory, previous))).equals(after))
          next[path] = previous;
        else
          Object.assign(
            next,
            await this.checkpoint(turn.view.id, randomUUID(), new Map([[path, after]])),
          );
      }
      const a = decodeText(before),
        b = decodeText(after);
      changes.push({
        path,
        before: a?.slice(0, 200000) ?? null,
        after: b?.slice(0, 200000) ?? null,
        kind: before === null ? 'created' : after === null ? 'deleted' : 'modified',
        binary: (before !== null && a === null) || (after !== null && b === null),
        review: 'pending',
        humanTouched: turn.human.includes(path),
        ...this.comparison(
          a,
          b,
          turn.after[path] === next[path]
            ? turn.view.changes.find((c) => c.path === path)
            : undefined,
        ),
      });
    }
    turn.after = next;
    turn.view.changes = changes;
    this.persist();
  }
  async finish(status: AgentTurn['status'], messageMayExist = true) {
    const turn = this.running();
    if (!turn) return;
    await this.observe(turn);
    turn.view.status = status;
    turn.view.resultRevision = this.projects.snapshot().sourceRevision;
    if (!messageMayExist) turn.view.messageAssociationResolved = true;
    turn.unsettled = false;
    this.persist();
  }
  unsettledExternal() {
    return this.turns.find((t) => t.unsettled && t.external);
  }
  unsettled() {
    return this.turns.find((t) => t.unsettled);
  }
  async settleExternal() {
    const turn = this.unsettledExternal();
    if (turn) {
      await this.observe(turn);
      turn.unsettled = false;
      this.persist();
    }
  }
  async recoverInterrupted() {
    const turn = this.turns.find((t) => t.unsettled && !t.external);
    if (turn) {
      // PID reuse or an inaccessible process remains conservatively unresolved.
      if (!turn.supervisorPid) return false;
      try {
        process.kill(turn.supervisorPid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
      await this.observe(turn);
      turn.unsettled = false;
      this.persist();
    }
    return true;
  }
  async review(turnId: string, path: string, action: 'keep' | 'revert', revision: string) {
    if (this.unsettled())
      throw new Error('Reconnect and stop the request before reviewing its changes.');
    const turn = this.turns.find((t) => t.view.id === turnId),
      change = turn?.view.changes.find((c) => c.path === path);
    if (!turn || !change || change.review !== 'pending')
      throw new Error('This change has already been reviewed.');
    if (action === 'keep') {
      change.review = 'kept';
      this.persist();
      return;
    }
    await this.projects.refresh();
    if (this.projects.snapshot().sourceRevision !== revision)
      throw new Error('The paper changed. Review the latest version and try again.');
    if (change.humanTouched)
      throw new Error(
        'You also edited this file during the request. The saved comparison is available; copy the passages you want to restore so your writing is preserved.',
      );
    const before = turn.before[path]
      ? await fs.readFile(join(this.directory, turn.before[path]))
      : null;
    const after = turn.after[path]
      ? await fs.readFile(join(this.directory, turn.after[path]))
      : null;
    const current = (await this.projects.agentFiles(this.projectId)).get(path) ?? null;
    let desired = before;
    if (before && after && current && !current.equals(after)) {
      const a = decodeText(after),
        b = decodeText(current),
        c = decodeText(before);
      const merged =
        a !== null && b !== null && c !== null
          ? reconcile(a, b, c, { timeout: 20, maxEditLength: 2000 })
          : null;
      if (merged === null)
        throw new Error(
          'Your newer writing overlaps this change. Use the comparison to restore only the passages you want. Both versions are retained.',
        );
      desired = Buffer.from(merged);
    } else if (
      (current === null) !== (after === null) ||
      (current && after && !current.equals(after))
    )
      throw new Error(
        'This file has newer changes. Both versions are retained; review it before reverting.',
      );
    // Recoverable current bytes exist even if the process stops during the restore.
    if (current)
      await this.checkpoint(turn.view.id, 'revert-' + randomUUID(), new Map([[path, current]]));
    await this.projects.agentRestore(this.projectId, path, current, desired);
    change.review = 'reverted';
    this.persist();
  }
}
