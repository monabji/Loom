import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  buildSettingsSchema,
  buildStateSchema,
  defaultBuildSettings,
  type BuildRecord,
  type BuildSettings,
  type BuildState,
  type LatexCommand,
  type LatexValue,
} from '../../contracts/latex';
import { ProjectService } from '../project/projects';
import { detectTools, runTool, latexEnvironment, type Tool } from './tools';
import { compilerDiagnostics, mappedPath } from './diagnostics';

export type BuildInput = Awaited<ReturnType<ProjectService['buildContext']>>;
export type StoredBuild = { record: BuildRecord; paths: string[]; directory: string };
type Session = {
  state: BuildState;
  retained: StoredBuild | null;
  abort?: AbortController;
  pending: { clean: boolean } | null;
  task?: Promise<void>;
};
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export class BuildService {
  private sessions = new Map<string, Session>();
  private tools: Tool[] = [];
  private detecting?: Promise<Tool[]>;
  constructor(
    private projects: ProjectService,
    private cache: string,
  ) {}
  async detect(force = false) {
    if (this.detecting) return this.detecting;
    if (!this.tools.length || force) {
      this.detecting = detectTools();
      try {
        this.tools = await this.detecting;
      } finally {
        this.detecting = undefined;
      }
    }
    return this.tools;
  }
  private session(projectId: string): Session {
    this.projects.buildContext(projectId);
    let session = this.sessions.get(projectId);
    if (!session) {
      let settings = this.projects.buildContext(projectId).settings ?? defaultBuildSettings;
      let saved: { current: BuildRecord | null; retained: StoredBuild | null } = {
        current: null,
        retained: null,
      };
      try {
        settings =
          this.projects.buildContext(projectId).settings ??
          buildSettingsSchema.parse(
            JSON.parse(this.projects.store.get(`build-settings:${projectId}`) ?? 'null'),
          );
      } catch {
        /* Defaults. */
      }
      try {
        saved = JSON.parse(this.projects.store.get(`build-state:${projectId}`) ?? 'null') ?? saved;
        if (saved.current) saved.current = buildStateSchema.shape.current.parse(saved.current);
        if (saved.retained) buildStateSchema.shape.successful.parse(saved.retained.record);
      } catch {
        saved = { current: null, retained: null };
      }
      if (saved.current?.status === 'running') {
        saved.current.status = 'interrupted';
        saved.current.finishedAt = new Date().toISOString();
        saved.current.log += '\nBuild interrupted by service shutdown. Compile again.';
      }
      session = {
        state: {
          projectId,
          settings,
          tools: [],
          current: saved.current,
          successful: saved.retained?.record ?? null,
          queued: false,
        },
        retained: saved.retained,
        pending: null,
      };
      this.sessions.set(projectId, session);
    }
    const configured = this.projects.buildContext(projectId).settings;
    if (configured) session.state.settings = configured;
    session.state.tools = this.tools.map(({ executable: _path, ...tool }) => tool);
    return session;
  }
  private persist(session: Session) {
    this.projects.store.set(
      `build-state:${session.state.projectId}`,
      JSON.stringify({ current: session.state.current, retained: session.retained }),
    );
  }
  active(): boolean {
    return [...this.sessions.values()].some((session) => !!(session.task || session.pending));
  }
  async status(projectId: string, detect = false): Promise<BuildState> {
    await this.detect(detect);
    return structuredClone(this.session(projectId).state);
  }
  async settings(projectId: string, settings: BuildSettings): Promise<BuildState> {
    await this.projects.run(() => this.projects.configureBuild(projectId, settings));
    const session = this.session(projectId);
    session.state.settings = settings;
    this.projects.store.set(`build-settings:${projectId}`, JSON.stringify(settings));
    return structuredClone(session.state);
  }
  request(projectId: string, clean: boolean): BuildState {
    const session = this.session(projectId);
    if (session.task) {
      session.pending = { clean: clean || !!session.pending?.clean };
      session.state.queued = true;
    } else this.start(session, clean);
    return structuredClone(session.state);
  }
  cancel(projectId: string): BuildState {
    const session = this.session(projectId);
    session.pending = null;
    session.state.queued = false;
    session.abort?.abort();
    return structuredClone(session.state);
  }
  private start(session: Session, clean: boolean) {
    const projectId = session.state.projectId;
    const abort = new AbortController();
    session.abort = abort;
    const input = this.projects.buildContext(projectId);
    const root = input.snapshot.files.find(
      (f) => f.id === input.snapshot.rootId && !f.deleted,
    )?.path;
    if (!root) throw new Error('Choose a root .tex document in Project settings before compiling.');
    const record: BuildRecord = {
      id: randomUUID(),
      projectId,
      revision: input.snapshot.sourceRevision!,
      root,
      settings: { ...session.state.settings },
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: 'Preparing a saved source snapshot…\n',
      diagnostics: [],
      tools: [],
      hasPdf: false,
      hasSynctex: false,
    };
    session.state.current = record;
    this.persist(session);
    // The asynchronous snapshot capture alone enters the project queue. TeX never does.
    session.task = this.execute(session, record, clean, abort.signal)
      .catch((error: unknown) => {
        record.status = abort.signal.aborted ? 'cancelled' : 'failed';
        record.log = (
          record.log +
          '\n' +
          (error instanceof Error ? error.message : 'Build failed.')
        ).slice(-140000);
      })
      .finally(async () => {
        record.finishedAt = new Date().toISOString();
        this.persist(session);
        session.task = undefined;
        session.abort = undefined;
        const pending = session.pending;
        session.pending = null;
        session.state.queued = false;
        // A project switch invalidates pending intent; it never builds the new project.
        if (pending && this.projects.nativeLocation()?.projectId === projectId) {
          try {
            this.start(session, pending.clean);
          } catch (error) {
            session.state.current = {
              ...record,
              id: randomUUID(),
              status: 'failed',
              finishedAt: new Date().toISOString(),
              log: error instanceof Error ? error.message : 'Queued build could not start.',
            };
            this.persist(session);
          }
        }
      });
  }
  private async capture(projectId: string, directory: string): Promise<BuildInput> {
    return this.projects.run(async () => {
      await this.projects.command({ type: 'refresh' });
      const input = this.projects.buildContext(projectId);
      if (input.snapshot.files.some((f) => !f.deleted && (f.conflict || !f.saved)))
        throw new Error('Resolve external conflicts and save all source before compiling.');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      let total = 0;
      for (const file of input.files) {
        const source = join(input.root, file.path);
        // Recheck every component: snapshots must never follow a newly introduced symlink.
        let path = input.root;
        for (const part of file.path.split('/')) {
          path = join(path, part);
          if ((await fs.lstat(path)).isSymbolicLink())
            throw new Error('A project path became a symbolic link. Refresh and retry.');
        }
        const stat = await fs.stat(source);
        total += stat.size;
        if (total > 128 * 1024 * 1024)
          throw new Error('Build snapshots support up to 128 MiB of project inputs.');
        const bytes = await fs.readFile(source);
        const revision = file.revision?.startsWith('stat:')
          ? `stat:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
          : digest(bytes);
        if (revision !== file.revision)
          throw new Error('An input changed while preparing the build. Compile again.');
        await fs.mkdir(dirname(join(directory, file.path)), { recursive: true });
        await fs.writeFile(join(directory, file.path), bytes, { flag: 'wx' });
      }
      await this.projects.refresh();
      if (
        this.projects.buildContext(projectId).snapshot.sourceRevision !==
        input.snapshot.sourceRevision
      )
        throw new Error('Project inputs changed while preparing the build. Compile again.');
      return input;
    });
  }
  private async execute(
    session: Session,
    record: BuildRecord,
    clean: boolean,
    signal: AbortSignal,
  ) {
    const directory = join(this.cache, record.projectId, record.id);
    const source = join(directory, 'source'),
      output = join(directory, 'output');
    try {
      const input = await this.capture(record.projectId, source);
      if (input.configError) throw new Error(input.configError);
      if (signal.aborted) throw new Error('Build cancelled.');
      record.revision = input.snapshot.sourceRevision!;
      if (input.settings) record.settings = { ...input.settings };
      record.root = input.files.find((f) => f.id === input.snapshot.rootId)?.path ?? record.root;
      const required = ['latexmk', record.settings.engine];
      const text = input.files.map((f) => f.text ?? '').join('\n');
      const biber =
        record.settings.bibliography === 'biber' ||
        (record.settings.bibliography === 'auto' &&
          /\\(?:usepackage(?:\[[^\]]*\])?\{biblatex\}|addbibresource\b)/.test(text) &&
          !/backend\s*=\s*bibtex/.test(text));
      const bibtex =
        record.settings.bibliography === 'bibtex' ||
        (record.settings.bibliography === 'auto' && /\\bibliography\b/.test(text));
      if (
        record.settings.bibliography === 'bibtex' &&
        /\\(?:addbibresource|usepackage(?:\[[^\]]*\])?\{biblatex\})/.test(text) &&
        !/backend\s*=\s*bibtex/.test(text)
      )
        throw new Error(
          'This project uses biblatex with Biber. Select Biber or set backend=bibtex in the source.',
        );
      if (
        record.settings.bibliography === 'biber' &&
        /\\bibliography\b/.test(text) &&
        !/\\addbibresource\b|\\usepackage(?:\[[^\]]*\])?\{biblatex\}/.test(text)
      )
        throw new Error(
          'This project uses traditional BibTeX. Select BibTeX or configure biblatex with Biber in the source.',
        );
      if (record.settings.bibliography === 'biber' && /backend\s*=\s*bibtex/.test(text))
        throw new Error(
          'This project configures backend=bibtex. Select BibTeX or change the source backend to Biber.',
        );
      if (biber) required.push('biber');
      else if (bibtex) required.push('bibtex');
      await this.detect(
        required.some((name) => !this.tools.find((tool) => tool.name === name)?.available),
      );
      record.tools = this.tools.map(({ executable: _path, ...tool }) => tool);
      const missing = required.filter(
        (name) => !this.tools.find((t) => t.name === name)?.available,
      );
      if (missing.length)
        throw new Error(
          `Missing tools: ${missing.join(', ')}. Install a TeX distribution with latexmk and the selected engine/bibliography tool, then retry Create PDF or Check again in PDF settings.`,
        );
      await fs.mkdir(output, { recursive: true });
      const args = [
        '-norc',
        record.settings.engine === 'pdflatex'
          ? '-pdf'
          : record.settings.engine === 'xelatex'
            ? '-xelatex'
            : '-lualatex',
        '-no-shell-escape',
        '-interaction=nonstopmode',
        '-file-line-error',
        '-synctex=1',
        '-outdir=' + output,
      ];
      if (record.settings.bibliography === 'none') args.push('-bibtex-');
      else if (record.settings.bibliography === 'auto') args.push('-bibtex-cond');
      else args.push('-bibtex');
      if (clean) args.push('-gg');
      // Prefix ./ prevents a filename beginning with '-' from becoming an option.
      args.push('./' + record.root);
      record.log += `Snapshot ${record.revision.slice(0, 12)} · ${record.settings.engine} · ${biber ? 'Biber' : bibtex ? 'BibTeX' : 'automatic bibliography'}\n`;
      const result = await runTool(
        this.tools.find((t) => t.name === 'latexmk')!.executable!,
        args,
        {
          cwd: source,
          signal,
          env: { ...latexEnvironment(), openin_any: 'p', openout_any: 'p', TEXMFOUTPUT: output },
          onOutput: (chunk) => {
            record.log = (record.log + chunk.split(directory).join('[build]')).slice(-140000);
          },
        },
      );
      record.diagnostics = compilerDiagnostics(
        result.output,
        source,
        input.files.map((f) => f.path),
      );
      if (signal.aborted) {
        record.status = 'cancelled';
        return;
      }
      const pdf = join(output, basename(record.root, '.tex') + '.pdf');
      record.hasPdf = result.code === 0 && (await this.validPdf(pdf));
      record.hasSynctex =
        record.hasPdf &&
        (await fs.stat(pdf.replace(/\.pdf$/, '.synctex.gz')).then(
          () => true,
          () => false,
        ));
      record.status = record.hasPdf ? 'succeeded' : 'failed';
      if (record.hasPdf) {
        session.state.successful = record;
        session.retained = { record, paths: input.files.map((f) => f.path), directory };
      } else record.log += '\nBuild failed. The last successful PDF is retained.';
    } finally {
      // Keep only the active and last successful snapshot; never erase its mapping.
      const parent = join(this.cache, record.projectId);
      const keep = new Set([record.id, session.retained?.record.id]);
      for (const entry of await fs.readdir(parent).catch(() => []))
        if (!keep.has(entry)) await fs.rm(join(parent, entry), { recursive: true, force: true });
      if (session.retained?.record.id !== record.id)
        await fs.rm(directory, { recursive: true, force: true });
    }
  }
  private async validPdf(path: string) {
    try {
      const stat = await fs.stat(path);
      if (stat.size > 32 * 1024 * 1024) throw new Error('PDF exceeds the 32 MiB viewer limit.');
      return (await fs.readFile(path)).subarray(0, 5).toString() === '%PDF-';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  artifact(projectId: string, buildId: string) {
    const stored = this.session(projectId).retained;
    if (!stored || stored.record.id !== buildId)
      throw new Error(
        'This PDF snapshot is no longer available. Load the latest successful build.',
      );
    return {
      ...stored,
      pdf: join(stored.directory, 'output', basename(stored.record.root, '.tex') + '.pdf'),
      source: join(stored.directory, 'source'),
    };
  }
  async pdf(projectId: string, buildId: string): Promise<LatexValue> {
    const artifact = this.artifact(projectId, buildId);
    if (!(await this.validPdf(artifact.pdf)))
      throw new Error('The saved PDF is missing. Compile again.');
    return {
      kind: 'pdf',
      buildId,
      revision: artifact.record.revision,
      data: (await fs.readFile(artifact.pdf)).toString('base64'),
    };
  }
  async mapping(
    command: Extract<LatexCommand, { type: 'forward' | 'reverse' }>,
  ): Promise<LatexValue> {
    const artifact = this.artifact(command.projectId, command.buildId);
    if (!artifact.record.hasSynctex)
      throw new Error('This build has no SyncTeX mapping. Compile again with the standard recipe.');
    await this.detect();
    const executable = this.tools.find((t) => t.name === 'synctex')?.executable;
    if (!executable)
      throw new Error('Install the synctex tool to navigate between PDF and source.');
    if (command.type === 'forward' && !artifact.paths.includes(command.path))
      throw new Error('This source is not in the displayed PDF snapshot. Recompile first.');
    const args =
      command.type === 'forward'
        ? [
            'view',
            '-i',
            `${command.line}:0:${join(artifact.source, command.path)}`,
            '-o',
            artifact.pdf,
          ]
        : ['edit', '-o', `${command.page}:${command.x}:${command.y}:${artifact.pdf}`];
    const result = await runTool(executable, args, {
      cwd: artifact.source,
      timeoutMs: 5000,
      env: latexEnvironment(),
    });
    const field = (key: string) =>
      result.output.match(new RegExp('^' + key + ':(.+)$', 'm'))?.[1].trim();
    if (command.type === 'forward') {
      const page = Number(field('Page')),
        x = Number(field('x')),
        y = Number(field('y'));
      if (page > 0 && Number.isFinite(x) && Number.isFinite(y))
        return { kind: 'forward', page, x, y };
    } else {
      const input = field('Input');
      const path = input ? mappedPath(input, artifact.source, artifact.paths) : null;
      const line = Number(field('Line'));
      if (path && line > 0)
        return { kind: 'reverse', path, line, column: Math.max(0, Number(field('Column')) || 0) };
    }
    throw new Error(
      'No source mapping was found at this location. Try another passage or recompile.',
    );
  }
  async idle(projectId: string) {
    await this.sessions.get(projectId)?.task;
  }
  dispose() {
    for (const session of this.sessions.values()) {
      session.pending = null;
      session.abort?.abort();
    }
  }
}
