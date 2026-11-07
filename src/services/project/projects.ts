import {
  defaultBuildSettings,
  portableBuildSchema,
  type BuildSettings,
} from '../../contracts/latex';
import { constants, promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { unzipSync } from 'fflate';
import { relativePath, type ProjectCommand, type ProjectSnapshot } from '../../contracts/project';
import { MetadataStore } from './store';
import { reconcile, textChanges } from './reconcile';
import { imageMime } from '../../domain/images';
import { imageBytesMatch, validateImage } from '../agents/images';
type DiskFile = { text: string | null; inode: string; revision: string };
type CachedDiskFile = { signature: string; file: DiskFile };
type IndexInput = { id: string; path: string; binary: boolean; state: number[] };
type RecordFile = {
  id: string;
  path: string;
  baseline: string | null;
  state: number[];
  binary: boolean;
  deleted: boolean;
  inode: string;
  conflict: boolean;
  disk: string | null;
  diskKind?: 'text' | 'binary' | 'missing';
  diskRevision?: string | null;
  overrideHash?: string;
  recovery?: number[];
};
type Project = {
  id: string;
  name: string;
  rootId: string | null;
  files: RecordFile[];
  preferences: string | null;
  buildSettings?: BuildSettings;
  buildConfigError?: string;
  buildConfigRevision?: string;
};
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const foldersOverlap = (a: string, b: string) =>
  a === b ||
  a.startsWith(b.endsWith(sep) ? b : b + sep) ||
  b.startsWith(a.endsWith(sep) ? a : a + sep);
const MAX_FILE = 8 * 1024 * 1024;
const DIFF_BUDGET = { timeout: 20, maxEditLength: 1000 };
export class ProjectService {
  onHumanWrite?: (path: string) => void;
  private uncertainTrash = new Set<string>();
  private root = '';
  private loadedId = '';
  private project: Project | null = null;
  private documents = new Map<string, Y.Doc>();
  private queue: Promise<unknown> = Promise.resolve();
  private scanCache = new Map<string, CachedDiskFile>();
  private indexed: { inputs: IndexInput[]; revision: number } | null = null;
  constructor(readonly store: MetadataStore) {}
  run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  private persist(): void {
    if (this.project) this.store.save(this.root, JSON.stringify(this.project));
  }
  private doc(file: RecordFile): Y.Doc {
    let doc = this.documents.get(file.id);
    if (!doc) {
      doc = new Y.Doc();
      if (file.state.length) Y.applyUpdate(doc, Uint8Array.from(file.state));
      this.documents.set(file.id, doc);
    }
    return doc;
  }
  private setText(file: RecordFile, text: string, explicit = false): boolean {
    const doc = this.doc(file);
    const live = doc.getText('source');
    const old = live.toString();
    if (old === text) {
      file.state = Array.from(Y.encodeStateAsUpdate(doc));
      return true;
    }
    let changes: ReturnType<typeof textChanges>;
    try {
      // Empty documents need no diff. A deliberate resolution or a clean incoming
      // replacement may patch its changed span when a detailed diff is too costly.
      changes = old === '' ? [{ from: 0, to: 0, text }] : textChanges(old, text, DIFF_BUDGET);
    } catch {
      if (!explicit) return false;
      let start = 0,
        endOld = old.length,
        endNew = text.length;
      while (start < endOld && start < endNew && old[start] === text[start]) start++;
      while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) {
        endOld--;
        endNew--;
      }
      changes = [{ from: start, to: endOld, text: text.slice(start, endNew) }];
    }
    changes.sort((a, b) => b.from - a.from);
    doc.transact(() => {
      for (const change of changes) {
        live.delete(change.from, change.to - change.from);
        live.insert(change.from, change.text);
      }
    }, 'filesystem');
    file.state = Array.from(Y.encodeStateAsUpdate(doc));
    return true;
  }
  private async safe(path: string): Promise<string> {
    relativePath.parse(path);
    const target = resolve(this.root, path);
    if (!target.startsWith(this.root + sep)) throw new Error('Path is outside this project.');
    let current = this.root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new Error('Symbolic links are not editable project paths.');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return target;
  }
  private async scan(observe: boolean): Promise<Map<string, DiskFile>> {
    const found = new Map<string, DiskFile>();
    const cache = new Map<string, CachedDiskFile>();
    // Nanosecond metadata is only an observer invalidation hint. Operation refreshes
    // still read/hash content, and saves retain their independent disk comparisons.
    const statFile = (path: string) => fs.lstat(path, { bigint: true });
    const signature = (stat: Awaited<ReturnType<typeof statFile>>) =>
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
    let total = 0;
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name.startsWith('.loom-save-')) continue;
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          if (found.size >= 2000) throw new Error('This pilot supports up to 2,000 project files.');
          const stat = await statFile(path);
          if (!stat.isFile()) continue;
          const key = relative(this.root, path).split(sep).join('/');
          const stamp = signature(stat);
          // Enforce limits on every scan, including cache hits.
          if (stat.size <= BigInt(MAX_FILE)) {
            total += Number(stat.size);
            if (total > 32 * 1024 * 1024)
              throw new Error('This pilot supports up to 32 MiB of indexed project content.');
          }
          const cached = observe ? this.scanCache.get(key) : undefined;
          if (cached?.signature === stamp) {
            found.set(key, cached.file);
            cache.set(key, cached);
            continue;
          }
          let text: string | null = null;
          let revision = `stat:${stat.size}:${Number(stat.mtimeNs) / 1e6}:${Number(stat.ctimeNs) / 1e6}`;
          let stable = true;
          if (stat.size <= BigInt(MAX_FILE)) {
            const bytes = await fs.readFile(await this.safe(key));
            revision = hash(bytes);
            try {
              const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
              if (!decoded.includes('\0')) text = decoded;
            } catch {
              /* Binary assets stay on disk. */
            }
            // Never cache a read spanning a replacement or an in-place write.
            stable = signature(await statFile(path)) === stamp;
          }
          const file = { text, revision, inode: `${stat.dev}:${stat.ino}` };
          found.set(key, file);
          if (stable) cache.set(key, { signature: stamp, file });
        }
      }
    };
    try {
      await walk(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          'A project folder or file is unavailable. Reconnect its drive or restore its folder. Saved recovery data has been retained.',
        );
      throw error;
    }
    // Publish only complete scans; removals evict cached paths, and failures retry.
    this.scanCache = cache;
    return found;
  }
  async open(path: string): Promise<ProjectSnapshot> {
    const root = await fs.realpath(path);
    if ([...this.uncertainTrash].some((pending) => foldersOverlap(root, pending)))
      throw new Error(
        'System Trash has not confirmed this folder. Restart Loom and inspect its folder and Trash before reopening it.',
      );
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Choose a project folder.');
    this.persist();
    const previous = {
      root: this.root,
      project: this.project,
      documents: this.documents,
      loadedId: this.loadedId,
      scanCache: this.scanCache,
      indexed: this.indexed,
    };
    this.documents = new Map();
    this.scanCache = new Map();
    this.indexed = null;
    this.root = root;
    this.loadedId = '';
    try {
      const stored = this.store.load(root);
      this.project = stored
        ? JSON.parse(stored)
        : { id: randomUUID(), name: basename(root), rootId: null, files: [], preferences: null };
      delete this.project!.buildConfigRevision;
      await this.refresh();
      this.persist();
      this.store.set('lastProject', root);
      this.store.rememberProject(root, this.project!.id, this.project!.name);
      for (const doc of previous.documents.values()) doc.destroy();
      return this.snapshot();
    } catch (error) {
      for (const doc of this.documents.values()) doc.destroy();
      this.root = previous.root;
      this.project = previous.project;
      this.documents = previous.documents;
      this.loadedId = previous.loadedId;
      this.scanCache = previous.scanCache;
      this.indexed = previous.indexed;
      throw error;
    }
  }

  async library() {
    return Promise.all(
      this.store.recentProjects().map(async (entry) => {
        let available = false;
        try {
          available = (await fs.stat(entry.path)).isDirectory();
        } catch {
          /* Keep missing projects visible. */
        }
        const deleteBlockedReason = await this.deletionBlock(entry.path);
        return { ...entry, available, ...(deleteBlockedReason ? { deleteBlockedReason } : {}) };
      }),
    );
  }
  async closeProject(projectId: string): Promise<void> {
    if (!this.project || this.project.id !== projectId)
      throw new Error('The open project changed.');
    await this.refresh();
    if (this.snapshot().files.some((file) => !file.deleted && (file.conflict || !file.saved)))
      throw new Error('Save your changes and resolve conflicts before closing the project.');
    this.persist();
    this.store.db.prepare('DELETE FROM preferences WHERE key=?').run('lastProject');
    for (const doc of this.documents.values()) doc.destroy();
    this.documents.clear();
    this.project = null;
    this.root = '';
    this.loadedId = '';
    this.scanCache.clear();
    this.indexed = null;
  }
  private recoveryText(file: RecordFile): string {
    const doc = new Y.Doc();
    try {
      if (file.state.length) Y.applyUpdate(doc, Uint8Array.from(file.state));
      return doc.getText('source').toString();
    } finally {
      doc.destroy();
    }
  }
  private async deletionBlock(path: string): Promise<string | null> {
    if ([...this.uncertainTrash].some((pending) => foldersOverlap(path, pending)))
      return 'System Trash did not reply. Restart Loom and inspect the folder and Trash before retrying.';
    const active = this.root || this.store.get('lastProject');
    if (!active) return null;
    let current = active;
    try {
      current = await fs.realpath(active);
    } catch {}
    if (foldersOverlap(current, path))
      return 'This folder is open, contains the open project, or belongs to it. Close the project or open a different project before deleting it.';
    return null;
  }
  async removeProject(
    projectId: string,
    mode: 'trash' | 'forget',
    trash: (path: string) => Promise<void>,
  ) {
    const entry = this.store.recentProjects().find((entry) => entry.id === projectId);
    if (!entry) throw new Error('This project is no longer in the local library.');
    const blocked = await this.deletionBlock(entry.path);
    if (blocked) throw new Error(blocked);
    let stat;
    try {
      stat = await fs.lstat(entry.path);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new Error('The folder cannot be accessed. Reconnect it before moving it to Trash.');
    }
    if (mode === 'forget') {
      if (stat?.isDirectory() || stat?.isSymbolicLink())
        throw new Error('This folder is available. Refresh the library before removing it.');
    } else {
      if (!stat?.isDirectory())
        throw new Error(
          'The folder is unavailable. Refresh the library to remove it from the list.',
        );
      const canonical = await fs.realpath(entry.path);
      if (canonical !== entry.path || dirname(canonical) === canonical)
        throw new Error('The project folder changed or is not safe to move to Trash.');
      if (
        this.store.db.location() &&
        resolve(this.store.db.location()!).startsWith(canonical + sep)
      )
        throw new Error('This folder contains Loom recovery data and cannot be moved to Trash.');
      const recovery = this.store.load(entry.path);
      if (recovery) {
        const project: Project = JSON.parse(recovery);
        if (
          project.files.some(
            (file) =>
              !file.deleted &&
              (file.conflict || (!file.binary && this.recoveryText(file) !== file.baseline)),
          )
        )
          throw new Error('Open this project and save or resolve its changes before deleting it.');
      }
      try {
        await trash(canonical);
      } catch (error) {
        if (error instanceof Error && error.name === 'TrashOutcomeUnknown')
          this.uncertainTrash.add(canonical);
        throw error;
      }
    }
    this.store.forgetProject(entry.path);
  }
  async reopen(projectId: string) {
    const entry = this.store.recentProjects().find((entry) => entry.id === projectId);
    if (!entry)
      throw new Error('This project is not in the local library. Open its folder to add it.');
    try {
      return await this.open(entry.path);
    } catch {
      throw new Error(
        'This project folder is unavailable or could not be loaded. Reconnect its drive or restore its folder at the original location. Saved recovery data has been retained.',
      );
    }
  }
  async current(allowMissing = false): Promise<ProjectSnapshot | null> {
    if (!this.project) {
      const last = this.store.get('lastProject');
      if (last) {
        if (allowMissing) {
          try {
            if (!(await fs.stat(last)).isDirectory()) return null;
          } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
              return null;
            throw error;
          }
        }
        try {
          return await this.open(last);
        } catch {
          throw new Error('The last project is unavailable. Open its folder to reconnect.');
        }
      }
    }
    return this.project ? this.snapshot() : null;
  }
  nativeLocation() {
    return this.project ? { projectId: this.project.id, path: this.root } : null;
  }
  async openMainFolder(projectId: string): Promise<ProjectSnapshot> {
    await this.refresh();
    const context = this.buildContext(projectId);
    const root = context.snapshot.files.find(
      (file) => file.id === context.snapshot.rootId && !file.deleted,
    );
    if (!root || !root.path.includes('/'))
      throw new Error('Choose a main document in a paper folder first.');
    if (context.snapshot.files.some((file) => !file.deleted && (file.conflict || !file.saved)))
      throw new Error(
        'Save your changes and review conflicting files before opening the paper folder.',
      );
    const path = await this.safe(root.path);
    if (!(await fs.stat(path)).isFile())
      throw new Error('The main document is no longer available.');
    await this.open(dirname(path));
    const chosen = this.project?.files.find(
      (file) => !file.deleted && file.path === basename(path),
    );
    // Preserve the explicit selection unless this folder has its own portable configuration.
    if (
      chosen &&
      !this.project?.files.some((file) => !file.deleted && file.path === 'loom.build.json')
    ) {
      await this.command({ type: 'root', fileId: chosen.id });
    }
    return this.snapshot();
  }
  async openSample(source: string, destination: string): Promise<ProjectSnapshot> {
    // Both locations are fixed by main; the renderer supplies only an allowlisted sample name.
    await fs.mkdir(dirname(destination), { recursive: true });
    try {
      const stat = await fs.lstat(destination);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('The sample folder is unavailable. Choose another project folder.');
      return this.open(destination); // Preserve a researcher's earlier sample edits.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.importFolder(source, destination);
  }
  async createFile(path: string, projectId: string): Promise<ProjectSnapshot | null> {
    await this.current();
    if (this.project?.id !== projectId)
      throw new Error('The open project changed. Choose the file location again.');
    const target = resolve(path);
    if (!target.startsWith(this.root + sep))
      throw new Error('Choose a location inside the open project folder.');
    return this.command({ type: 'create', path: relative(this.root, target).split(sep).join('/') });
  }
  private async saveImage(projectId: string, path: string, bytes: Buffer) {
    if (this.project?.id !== projectId)
      throw new Error('The open paper changed. Choose the image again.');
    const mime = imageMime(path);
    if (!mime || bytes.length > 10 * 1024 * 1024 || !imageBytesMatch(mime, bytes))
      throw new Error('Choose a PNG, JPEG, GIF or WebP image of at most 10 MiB.');
    const target = await this.safe(path);
    if (dirname(target) !== this.root)
      throw new Error('Imported images must be saved in the paper folder.');
    const temporary = join(this.root, `.loom-save-${randomUUID()}`);
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(temporary, 'wx');
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = undefined;
      await fs.link(temporary, target);
      const directory = await fs.open(this.root, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file?.close();
      await fs.rm(temporary, { force: true });
    }
    await this.refresh();
    return this.snapshot();
  }
  async importExternalImage(projectId: string, source: string, path: string) {
    await this.current();
    if (this.project?.id !== projectId)
      throw new Error('The open paper changed. Choose the image again.');
    const mime = imageMime(source);
    if (!mime || imageMime(path) !== mime) throw new Error('Choose a supported image file.');
    const file = await fs.open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 10 * 1024 * 1024)
        throw new Error('Choose an image of at most 10 MiB.');
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await file.stat();
      if (
        offset !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error('The selected image changed while it was being copied. Choose it again.');
      return await this.saveImage(projectId, path, buffer.subarray(0, offset));
    } finally {
      await file.close();
    }
  }
  async create(path: string): Promise<ProjectSnapshot> {
    await fs.mkdir(path, { recursive: false });
    await fs.writeFile(
      join(path, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n\n\\end{document}\n',
      { flag: 'wx' },
    );
    return this.open(path);
  }
  async importFolder(source: string, destination: string): Promise<ProjectSnapshot> {
    const src = await fs.realpath(source);
    if (resolve(destination).startsWith(src + sep) || resolve(destination) === src)
      throw new Error('Choose a destination outside the source folder.');
    await fs.mkdir(destination, { recursive: false });
    for (const entry of await fs.readdir(src))
      await fs.cp(join(src, entry), join(destination, entry), {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: async (path) =>
          !(await fs.lstat(path)).isSymbolicLink() && basename(path) !== '.git',
      });
    return this.open(destination);
  }
  async importZip(source: string, destination: string): Promise<ProjectSnapshot> {
    const bytes = await fs.readFile(source);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('ZIP exceeds the 64 MiB import limit.');
    let total = 0,
      count = 0;
    const entries = unzipSync(bytes, {
      filter: (file) => {
        relativePath.parse(file.name.replace(/\/$/, ''));
        total += file.originalSize;
        if (++count > 2000 || total > 128 * 1024 * 1024)
          throw new Error('ZIP exceeds project import limits.');
        return !file.name.split('/').includes('.git');
      },
    });
    await fs.mkdir(destination, { recursive: false });
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/')) {
        await fs.mkdir(join(destination, path), { recursive: true });
        continue;
      }
      await fs.mkdir(dirname(join(destination, path)), { recursive: true });
      await fs.writeFile(join(destination, path), data, { flag: 'wx' });
    }
    return this.open(destination);
  }
  async refresh(observe = false): Promise<void> {
    if (!this.project) return;
    const disk = await this.scan(observe);
    for (const file of this.project.files) {
      let found = disk.get(file.path);
      if (!found && !file.deleted) {
        const renamed = [...disk].find(
          ([path, v]) =>
            v.inode === file.inode &&
            !this.project!.files.some((f) => f.path === path && !f.deleted),
        );
        if (renamed) {
          file.path = renamed[0];
          found = renamed[1];
        }
      }
      file.diskKind = found ? (found.text === null ? 'binary' : 'text') : 'missing';
      file.diskRevision = found?.revision ?? null;
      if (file.deleted) {
        if (found) {
          disk.delete(file.path);
          file.deleted = false;
          file.conflict = true;
          file.disk = found.text;
        }
        continue;
      }
      if (!found) {
        file.conflict = true;
        file.disk = null;
        continue;
      }
      disk.delete(file.path);
      file.inode = found.inode;
      if (file.binary) {
        continue;
      }
      const local = this.doc(file).getText('source').toString();
      file.disk = found.text;
      if (found.text === null) {
        file.conflict = true;
        continue;
      }
      if (found.text === file.baseline) {
        if (!file.conflict) continue;
        if (local === found.text) file.conflict = false;
        continue;
      }
      const merged = reconcile(file.baseline ?? '', local, found.text, DIFF_BUDGET);
      if (merged === null) {
        file.conflict = true;
        continue;
      }
      if (!this.setText(file, merged, local === file.baseline)) {
        file.conflict = true;
        continue;
      }
      file.baseline = found.text;
      file.conflict = false;
    }
    for (const [path, found] of disk) {
      const file: RecordFile = {
        id: randomUUID(),
        path,
        baseline: found.text,
        state: [],
        binary: found.text === null,
        deleted: false,
        inode: found.inode,
        conflict: false,
        disk: found.text,
        diskKind: found.text === null ? 'binary' : 'text',
        diskRevision: found.revision,
      };
      if (found.text !== null) this.setText(file, found.text);
      this.project.files.push(file);
    }
    if (!this.project.rootId) {
      const roots = this.project.files.filter(
        (f) => !f.deleted && f.baseline?.includes('\\documentclass'),
      );
      if (roots.length === 1) this.project.rootId = roots[0].id;
    }
    this.readBuildConfiguration();
    this.persist();
    const liveFiles = this.project.files.filter((file) => !file.deleted);
    const inputs = liveFiles.map(({ id, path, binary, state }) => ({ id, path, binary, state }));
    const previous = this.indexed;
    if (
      !previous ||
      previous.revision !== this.store.changeCount() ||
      inputs.length !== previous.inputs.length ||
      inputs.some((file, i) => {
        const old = previous.inputs[i];
        return (
          file.id !== old.id ||
          file.path !== old.path ||
          file.binary !== old.binary ||
          file.state !== old.state
        );
      })
    ) {
      this.store.index(
        this.root,
        liveFiles.map((file) => ({
          id: file.id,
          path: file.path,
          content: file.binary ? '' : this.doc(file).getText('source').toString(),
        })),
      );
      this.indexed = { inputs, revision: this.store.changeCount() };
    }
  }

  private async save(file: RecordFile, source: 'human' | 'agent' = 'human'): Promise<void> {
    if (file.binary || file.deleted || file.conflict) return;
    const text = this.doc(file).getText('source').toString();
    if (text === file.baseline) return;
    const target = await this.safe(file.path);
    let bytes: Buffer | null = null;
    try {
      bytes = await fs.readFile(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const expected = file.overrideHash ?? (file.baseline === null ? null : hash(file.baseline));
    const diskHash = bytes === null ? null : hash(bytes);
    if (diskHash !== expected) {
      file.conflict = true;
      file.diskRevision = diskHash;
      file.disk = bytes?.toString('utf8') ?? null;
      this.persist();
      return;
    }
    if (source === 'human') this.onHumanWrite?.(file.path);
    this.persist();
    const temp = join(dirname(target), `.loom-save-${randomUUID()}`);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      let latest: Buffer | null = null;
      try {
        latest = await fs.readFile(target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if ((latest === null ? null : hash(latest)) !== diskHash) {
        file.conflict = true;
        file.diskRevision = latest === null ? null : hash(latest);
        file.disk = latest?.toString('utf8') ?? null;
        this.persist();
        return;
      }
      try {
        await fs.chmod(temp, (await fs.stat(target)).mode);
      } catch {
        /* New file. */
      }
      await fs.rename(temp, target);
      const dir = await fs.open(dirname(target), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      delete file.overrideHash;
      file.diskKind = 'text';
      file.diskRevision = hash(text);
      file.baseline = text;
      file.disk = text;
      const stat = await fs.stat(target);
      file.inode = `${stat.dev}:${stat.ino}`;
      this.persist();
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async command(command: ProjectCommand): Promise<ProjectSnapshot | null> {
    if (command.type === 'reopen') return this.reopen(command.projectId);
    if (
      command.type === 'close-project' ||
      command.type === 'trash-project' ||
      command.type === 'forget-project'
    )
      throw new Error('Use the native project removal boundary.');
    if (command.type === 'library') throw new Error('Use the library result boundary.');
    if (command.type === 'current') return this.current();
    if (!this.project) await this.current();
    if (!this.project) throw new Error('Open a project first.');
    // Preferences are private metadata; an unplugged project must not prevent saving working state or leaving it.
    if (command.type === 'preferences') {
      this.project.preferences = command.value;
      this.persist();
      return this.snapshot();
    }
    if (command.type === 'load') this.loadedId = command.fileId;
    if (command.type === 'sync') {
      this.loadedId = command.fileId;
      const file = this.project.files.find((f) => f.id === command.fileId);
      if (!file || file.binary) throw new Error('Text file is unavailable.');
      Y.applyUpdate(this.doc(file), Uint8Array.from(command.update));
      if (command.baseline !== file.baseline && command.text !== command.baseline) {
        const merged = reconcile(
          command.baseline ?? '',
          command.text,
          file.baseline ?? '',
          DIFF_BUDGET,
        );
        const applied = this.setText(file, merged ?? command.text);
        if (merged === null || !applied) {
          file.conflict = true;
          file.disk = file.baseline;
        }
      }
      file.state = Array.from(Y.encodeStateAsUpdate(this.doc(file)));
      this.persist();
    }
    await this.refresh(command.type === 'refresh');
    if (command.type === 'preview-image') {
      if (this.project.id !== command.projectId) throw new Error('The open paper changed.');
      const file = this.project.files.find((f) => f.path === command.path && !f.deleted);
      if (!file) throw new Error('This image is no longer in the paper.');
      const mime = imageMime(command.path);
      if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
        throw new Error('Unsupported image format.');
      await validateImage(this.root, command.path);
      const handle = await fs.open(await this.safe(command.path), 'r');
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024)
          throw new Error('This image is too large to preview.');
        bytes = Buffer.alloc(stat.size);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== bytes.length || !imageBytesMatch(mime, bytes))
          throw new Error('This image changed while opening. Try again.');
      } finally {
        await handle.close();
      }
      return {
        ...this.snapshot(),
        imagePreview: {
          path: command.path,
          mime: mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: bytes.toString('base64'),
        },
      };
    }
    if (command.type === 'search') {
      const hits = this.store.hits(this.root, command.query);
      return {
        ...this.snapshot(),
        matches: [...new Set(hits.map((hit) => hit.fileId))],
        hits,
      };
    }
    if (command.type === 'import-image') {
      return this.saveImage(command.projectId, command.path, Buffer.from(command.data, 'base64'));
    } else if (command.type === 'create') {
      const path = await this.safe(command.path);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, '', { flag: 'wx' });
      await this.refresh();
    } else if ('fileId' in command) {
      const file = this.project.files.find((f) => f.id === command.fileId);
      if (!file) throw new Error('File is no longer in this project.');
      if (command.type === 'root') {
        if (file.deleted || !file.path.endsWith('.tex'))
          throw new Error('Select a .tex root document.');
        this.project.rootId = file.id;
      }
      if (command.type === 'rename') {
        if (file.deleted || file.conflict) throw new Error('Resolve this file before renaming.');
        const target = await this.safe(command.path);
        try {
          await fs.lstat(target);
          throw new Error('A file already exists at that path.');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.rename(await this.safe(file.path), target);
        file.path = command.path;
      }
      if (command.type === 'delete') {
        if (file.conflict) throw new Error('Resolve this file before deletion.');
        const bytes = await fs.readFile(await this.safe(file.path));
        file.recovery = Array.from(bytes);
        this.persist();
        await fs.unlink(await this.safe(file.path));
        file.deleted = true;
        if (this.project.rootId === file.id) this.project.rootId = null;
      }
      if (command.type === 'restore') {
        if (!file.deleted && !(file.conflict && file.diskKind === 'missing' && file.recovery))
          throw new Error('This file has no deleted recovery copy.');
        const bytes =
          file.recovery ?? Array.from(Buffer.from(this.doc(file).getText('source').toString()));
        await fs.mkdir(dirname(await this.safe(file.path)), { recursive: true });
        await fs.writeFile(await this.safe(file.path), Uint8Array.from(bytes), { flag: 'wx' });
        file.deleted = false;
        file.baseline = file.binary ? null : Buffer.from(bytes).toString('utf8');
        file.conflict = false;
      }
      if (command.type === 'resolve') {
        if (!file.conflict) throw new Error('This conflict has already changed.');
        if (file.disk !== command.disk || (file.diskRevision ?? null) !== command.diskRevision)
          throw new Error('The disk changed again. Review the latest conflict.');
        if (command.choice === 'disk') {
          if (file.diskKind === 'binary') {
            file.binary = true;
            file.baseline = null;
          } else if (file.disk === null) {
            file.deleted = true;
          } else {
            this.setText(file, file.disk, true);
            file.baseline = file.disk;
          }
        } else {
          if (file.diskKind === 'binary') {
            if (file.diskRevision?.startsWith('stat:'))
              throw new Error(
                'This replacement exceeds the text size limit. Keep the disk asset or recover the source to another file.',
              );
            file.overrideHash = file.diskRevision ?? undefined;
          }
          file.baseline = file.disk;
        }
        file.conflict = false;
      }
    }
    this.persist();
    for (const file of this.project.files) await this.save(file);
    return this.snapshot();
  }
  private readBuildConfiguration() {
    if (!this.project) return;
    const file = this.project.files.find((f) => !f.deleted && f.path === 'loom.build.json');
    if (!file) {
      delete this.project.buildSettings;
      delete this.project.buildConfigError;
      delete this.project.buildConfigRevision;
      return;
    }
    const text = file.binary ? '' : this.doc(file).getText('source').toString();
    const baseRevision = hash(text) + ':' + String(file.conflict);
    try {
      if (file.conflict) throw new Error('Configuration needs external-change review.');
      const config = portableBuildSchema.parse(JSON.parse(text));
      const root = this.project.files.find(
        (f) => !f.deleted && f.path === config.root && f.path.endsWith('.tex'),
      );
      const revision = `${baseRevision}:${root?.id}:${root?.path}:${root?.diskKind}`;
      if (this.project.buildConfigRevision === revision) return;
      this.project.buildConfigRevision = revision;
      if (!root || root.diskKind !== 'text')
        throw new Error('Configured root is missing or unavailable.');
      this.project.rootId = root.id;
      this.project.buildSettings = config.settings;
      delete this.project.buildConfigError;
    } catch {
      delete this.project.buildConfigRevision;
      this.project.buildConfigError =
        'Invalid, missing-root or conflicting loom.build.json. Review the file, select the root and save build settings to repair it.';
    }
  }
  async configureBuild(
    projectId: string,
    settings: BuildSettings,
    source: 'human' | 'agent' = 'human',
  ) {
    const context = this.buildContext(projectId);
    const root = context.files.find((f) => f.id === context.snapshot.rootId)?.path;
    if (!root) throw new Error('Choose a root .tex document before saving build settings.');
    await this.refresh();
    let file = this.project!.files.find((f) => !f.deleted && f.path === 'loom.build.json');
    if (!file) {
      await this.command({ type: 'create', path: 'loom.build.json' });
      file = this.project!.files.find((f) => !f.deleted && f.path === 'loom.build.json');
    }
    if (!file || file.binary || file.conflict)
      throw new Error('Resolve external changes to loom.build.json before saving settings.');
    // Use the same checkpointed, fingerprint-checked atomic write as manuscript text.
    if (!this.setText(file, JSON.stringify({ version: 1, root, settings }, null, 2) + '\n'))
      throw new Error('Build configuration is too complex to update safely. Edit it manually.');
    this.persist();
    await this.save(file, source);
    if (file.conflict)
      throw new Error(
        'Build configuration changed on disk. Review the conflict before saving settings.',
      );
    await this.refresh();
  }
  /** Agent writes enter the same observed filesystem bridge; call inside run() after editor flush. */
  async agentCreateFile(projectId: string, path: string, text: string) {
    this.buildContext(projectId);
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE || text.includes('\0'))
      throw new Error('Use a bounded UTF-8 text file.');
    const target = await this.safe(path);
    await fs.mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.loom-save-${randomUUID()}`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.link(temporary, target);
      const folder = await fs.open(dirname(target), 'r');
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
    await this.refresh();
  }
  async agentSetRoot(projectId: string, path: string) {
    const context = this.buildContext(projectId);
    const file = this.project!.files.find((file) => !file.deleted && file.path === path);
    if (!file || file.binary || file.conflict || !path.endsWith('.tex'))
      throw new Error('Choose an available, conflict-free .tex document.');
    this.project!.rootId = file.id;
    await this.configureBuild(projectId, context.settings ?? defaultBuildSettings, 'agent');
  }
  /** Internal only: native roots never cross the renderer bridge. Call inside run(). */
  buildContext(projectId: string) {
    if (!this.project || this.project.id !== projectId)
      throw new Error('The open project changed.');
    const snapshot = this.snapshot();
    return {
      settings: this.project.buildSettings,
      configError: this.project.buildConfigError,
      root: this.root,
      snapshot,
      files: this.project.files
        .filter((f) => !f.deleted)
        .map((f) => ({
          id: f.id,
          path: f.path,
          diskKind: f.diskKind ?? (f.binary ? 'binary' : 'text'),
          revision: f.binary ? f.diskRevision : hash(this.doc(f).getText('source').toString()),
          text: f.binary ? null : this.doc(f).getText('source').toString(),
        })),
    };
  }
  /** Internal agent recovery boundary. Call only within run(), after renderer flush. */
  async agentFiles(projectId: string): Promise<Map<string, Buffer>> {
    await this.refresh();
    const context = this.buildContext(projectId);
    const result = new Map<string, Buffer>();
    let total = 0;
    for (const file of context.files) {
      if (file.diskKind === 'missing') continue;
      const target = await this.safe(file.path);
      const stat = await fs.stat(target);
      total += stat.size;
      if (total > 128 * 1024 * 1024)
        throw new Error('Agent recovery supports papers up to 128 MiB.');
      result.set(file.path, await fs.readFile(target));
    }
    return result;
  }
  async agentRestore(
    projectId: string,
    path: string,
    expected: Buffer | null,
    desired: Buffer | null,
  ): Promise<void> {
    this.buildContext(projectId);
    const target = await this.safe(path);
    let current: Buffer | null = null;
    try {
      current = await fs.readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      (current === null) !== (expected === null) ||
      (current && expected && !current.equals(expected))
    )
      throw new Error('This file changed again. Review its latest version before reverting.');
    const file =
      this.project!.files.find((f) => f.path === path && !f.deleted) ??
      this.project!.files.find((f) => f.path === path);
    if (
      file &&
      ((file.conflict &&
        !(
          expected === null &&
          file.diskKind === 'missing' &&
          this.doc(file).getText('source').toString() === file.baseline
        )) ||
        (!file.binary && this.doc(file).getText('source').toString() !== file.baseline))
    )
      throw new Error('Review or save your newer writing before reverting this file.');
    if (desired === null) {
      if (file) {
        file.recovery = Array.from(current!);
        this.persist();
      }
      await fs.unlink(target);
      if (file) {
        file.deleted = true;
        file.conflict = false;
        if (this.project!.rootId === file.id) this.project!.rootId = null;
        this.persist();
      }
    } else {
      await fs.mkdir(dirname(target), { recursive: true });
      if (!current) await fs.writeFile(target, desired, { flag: 'wx' });
      else {
        const temp = join(dirname(target), `.loom-save-${randomUUID()}`);
        try {
          const handle = await fs.open(temp, 'wx', 0o600);
          try {
            await handle.writeFile(desired);
            await handle.sync();
          } finally {
            await handle.close();
          }
          const latest = await fs.readFile(target);
          if (!latest.equals(current))
            throw new Error('This file changed again. Review before reverting.');
          await fs.rename(temp, target);
          const directory = await fs.open(dirname(target), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await fs.rm(temp, { force: true });
        }
      }
      if (file) {
        let text: string | null = null;
        try {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(desired);
          if (!decoded.includes('\0')) text = decoded;
        } catch {
          /* Binary recovery. */
        }
        file.binary = text === null;
        file.baseline = text;
        file.conflict = false;
        file.deleted = false;
        if (text !== null) this.setText(file, text, true);
        this.persist();
      }
    }
    await this.refresh();
  }
  snapshot(): ProjectSnapshot {
    const p = this.project!;
    return {
      id: p.id,
      name: p.name,
      rootId: p.rootId,
      preferences: p.preferences,
      sourceRevision: hash(
        JSON.stringify([
          p.rootId,
          p.files
            .filter((f) => !f.deleted)
            .map((f) => [
              f.path,
              f.binary ? f.diskRevision : hash(this.doc(f).getText('source').toString()),
              f.diskRevision ?? null,
              f.diskKind ?? null,
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ]),
      ),
      files: p.files.map((f) => {
        const text = f.binary ? null : this.doc(f).getText('source').toString();
        return {
          id: f.id,
          path: f.path,
          loaded: f.id === this.loadedId,
          text: f.binary ? null : f.id === this.loadedId ? text : '',
          update: f.id === this.loadedId ? f.state : [],
          baseline: f.id === this.loadedId ? f.baseline : null,
          disk: f.id === this.loadedId ? f.disk : null,
          diskKind: f.diskKind ?? (f.disk === null ? 'missing' : 'text'),
          diskRevision: f.id === this.loadedId ? (f.diskRevision ?? null) : null,
          conflict: f.conflict,
          deleted: f.deleted,
          revision: hash(text ?? ''),
          saved: !f.conflict && !f.deleted && text === f.baseline,
        };
      }),
    };
  }
}
