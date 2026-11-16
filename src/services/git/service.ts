import { basename, relative, resolve, sep } from 'node:path';
import { promises as fs } from 'node:fs';
import type { GitCommand, GitValue } from '../../contracts/git';
import { findExecutable, runTool } from '../latex/tools';

const outputLimit = 200_000;
const fileLimit = 5000;
const pathListLimit = 16 * 1024 * 1024;
type GitContext = { root: string; projectId: string; paths: string[] };
const gitLine = (value: string) => value.replace(/\r?\n$/, '');
const literal = (...args: string[]) => ['--literal-pathspecs', ...args];

export async function cloneRepository(url: string, destination: string): Promise<void> {
  const executable = await findExecutable('git');
  if (!executable) throw new Error('Git is unavailable. Install Git and reopen Loom.');
  const parent = await fs.realpath(resolve(destination, '..'));
  if (parent !== resolve(destination, '..'))
    throw new Error('Choose a regular destination folder.');
  try {
    await fs.lstat(destination);
    throw new Error('The clone destination already exists. Choose a new folder.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result = await runTool(executable, ['clone', '--', url, destination], {
    cwd: parent,
    timeoutMs: 240_000,
  });
  if (result.code !== 0)
    throw new Error(
      'Git clone failed. Check the network, remote access, and your existing Git credential helper or SSH setup. Any partial destination was left in place for inspection.',
    );
}
const privatePath = (path: string) =>
  /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|\.loom|\.codex|\.opencode|userData|recovery|conversations|metadata\.sqlite|node_modules|\.cache|\.DS_Store|\.ssh|credentials|secrets)(?:\/|$)/i.test(
    path,
  ) ||
  /(^|\/)(?:out|release|artifacts|coverage|dist|\.turbo)(\/|$)/i.test(path) ||
  /\.(?:aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex\.gz|blg|bcf|run\.xml|nav|snm|vrb|sqlite|sqlite3|db-wal|db-shm)$/i.test(
    path,
  );
async function conflictStages(executable: string, cwd: string, path: string) {
  const result = await runTool(executable, literal('ls-files', '-u', '-z', '--', path), {
    cwd,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) throw new Error('Could not inspect the unresolved conflict stages.');
  return new Set(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.split('\t', 1)[0]!.trim().split(' ').at(-1)!),
  );
}
const safeGitOutput = (text: string) =>
  text
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[credentials hidden]@')
    .replace(/(ssh:\/\/)[^/@\s]+@/gi, '$1[credentials hidden]@');

function parseStatus(raw: string) {
  const fields = raw.split('\0');
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0,
    behind = 0,
    detached = false;
  const files: {
    path: string;
    index: ' ' | 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';
    worktree: ' ' | 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';
    originalPath: string | null;
    crossesProjectBoundary: boolean;
    conflict: boolean;
  }[] = [];
  const conflictPairs = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i]!;
    if (!row) continue;
    if (row.startsWith('## ')) {
      const header = row.slice(3);
      detached = header.startsWith('HEAD ');
      const match = /^(.+?)(?:\.\.\.(.+?))?(?: \[(.*)\])?$/.exec(header);
      branch = detached ? null : (match?.[1] ?? null);
      upstream = match?.[2] ?? null;
      const counts = /ahead (\d+)|behind (\d+)/g;
      for (const count of header.matchAll(counts)) {
        if (count[1]) ahead = Number(count[1]);
        if (count[2]) behind = Number(count[2]);
      }
      continue;
    }
    const x = row[0] ?? ' ',
      y = row[1] ?? ' ';
    if (row.startsWith('?? ') || row.startsWith('!! ')) {
      files.push({
        path: row.slice(3),
        index: row[0] === '?' ? '?' : '!',
        worktree: row[0] === '?' ? '?' : '!',
        originalPath: null,
        crossesProjectBoundary: false,
        conflict: false,
      });
      continue;
    }
    const path = row.slice(3);
    let originalPath: string | null = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') originalPath = fields[++i] || null;
    files.push({
      path,
      index: x as never,
      worktree: y as never,
      originalPath,
      crossesProjectBoundary: false,
      conflict: conflictPairs.has(`${x}${y}`),
    });
  }
  return { branch, upstream, ahead, behind, detached, files, truncated: files.length > fileLimit };
}

export class GitService {
  constructor(private readonly contextFor: (projectId: string) => GitContext) {}

  async command(command: GitCommand): Promise<GitValue> {
    const context = this.contextFor(command.projectId);
    if (command.type === 'preflight' || command.type === 'archive')
      throw new Error('Source exports must use the snapshot export service.');
    const executable = await findExecutable('git');
    if (!executable) {
      if (command.type === 'status')
        return {
          kind: 'status' as const,
          repository: false,
          rootName: null,
          repositoryPrefix: '',
          branch: null,
          upstream: null,
          detached: false,
          mergeInProgress: false,
          indexMatchesHead: false,
          ahead: 0,
          behind: 0,
          files: [],
          truncated: false,
          gitAvailable: false,
          indexTree: null,
          branches: [],
          remotes: [],
          commitNotice: null,
        };
      throw new Error('Git is unavailable. Install Git and reopen Loom.');
    }
    const statusProbe = (args: string[], options: Parameters<typeof runTool>[2] = {}) =>
      runTool(executable, ['-c', 'core.fsmonitor=false', ...args], options);
    if (command.type === 'status') {
      const [root, status] = await Promise.all([
        statusProbe(['rev-parse', '--show-toplevel'], {
          cwd: context.root,
          timeoutMs: 10_000,
        }),
        statusProbe(
          ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--renames'],
          { cwd: context.root, timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024 },
        ),
      ]);
      if (root.code !== 0)
        return {
          kind: 'status' as const,
          repository: false,
          rootName: null,
          repositoryPrefix: '',
          branch: null,
          upstream: null,
          detached: false,
          mergeInProgress: false,
          indexMatchesHead: false,
          ahead: 0,
          behind: 0,
          files: [],
          truncated: false,
          gitAvailable: true,
          indexTree: null,
          branches: [],
          remotes: [],
          commitNotice: null,
        };
      if (status.code !== 0) throw new Error(status.output.slice(-1000) || 'Git status failed.');
      const projectPrefix = relative(gitLine(root.stdout), context.root).split(sep).join('/');
      const parsed = parseStatus(status.stdout);
      const projectFiles = projectPrefix
        ? parsed.files.flatMap((file) => {
            const prefix = `${projectPrefix}/`;
            if (!file.path.startsWith(prefix)) return [];
            const originalInsideProject = file.originalPath?.startsWith(prefix) ?? false;
            const originalPath = originalInsideProject
              ? file.originalPath!.slice(prefix.length)
              : file.originalPath;
            return [
              {
                ...file,
                path: file.path.slice(prefix.length),
                originalPath,
                crossesProjectBoundary: !!file.originalPath && !originalInsideProject,
              },
            ];
          })
        : parsed.files;
      const [remotes, gitPath, headTree, branchResult] = await Promise.all([
        statusProbe(['remote'], { cwd: context.root, timeoutMs: 10_000 }),
        statusProbe(['rev-parse', '--absolute-git-dir'], {
          cwd: context.root,
          timeoutMs: 10_000,
        }),
        statusProbe(['rev-parse', '--verify', 'HEAD^{tree}'], {
          cwd: context.root,
          timeoutMs: 10_000,
        }),
        statusProbe(['branch', '--format=%(refname:short)'], {
          cwd: context.root,
          timeoutMs: 10_000,
        }),
      ]);
      const treeResult = await runTool(executable, ['write-tree'], {
        cwd: context.root,
        timeoutMs: 10_000,
      });
      const mergeHead =
        gitPath.code === 0
          ? resolve(gitLine(gitPath.stdout), 'MERGE_HEAD')
          : resolve(context.root, '.git', 'MERGE_HEAD');
      const merge = await fs.access(mergeHead).then(
        () => true,
        () => false,
      );
      const indexTree = treeResult.code === 0 ? treeResult.stdout.trim() : null;
      return {
        kind: 'status' as const,
        repository: true,
        rootName: basename(gitLine(root.stdout)),
        repositoryPrefix: projectPrefix,
        branch: parsed.branch,
        upstream: parsed.upstream,
        detached: parsed.detached,
        mergeInProgress: merge,
        indexMatchesHead:
          !!indexTree && headTree.code === 0 && indexTree === headTree.stdout.trim(),
        ahead: parsed.ahead,
        behind: parsed.behind,
        files: projectFiles.slice(0, fileLimit),
        truncated: projectFiles.length > fileLimit || status.stdout.length >= 8 * 1024 * 1024,
        gitAvailable: true,
        indexTree,
        branches:
          branchResult.code === 0
            ? branchResult.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500)
            : [],
        remotes:
          remotes.code === 0 ? remotes.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100) : [],
        commitNotice: null,
      };
    }
    if (
      command.type === 'diff' ||
      command.type === 'stage' ||
      command.type === 'unstage' ||
      command.type === 'resolve'
    ) {
      const inProject = context.paths.includes(command.path);
      let tracked = false;
      if (!inProject) {
        const result = await runTool(
          executable,
          literal('ls-files', '--error-unmatch', '--', command.path),
          { cwd: context.root, timeoutMs: 10_000 },
        );
        tracked = result.code === 0;
      }
      if (!inProject && !tracked) throw new Error('Choose a file in the open project.');
      if (command.type === 'diff') {
        const conflictStage = { base: '1', ours: '2', theirs: '3' } as const;
        let args: string[];
        let indexTree: string | null = null;
        if (command.area === 'index') {
          const tree = await runTool(executable, ['write-tree'], {
            cwd: context.root,
            timeoutMs: 10_000,
          });
          if (tree.code !== 0) throw new Error('The Git index is not available for review.');
          indexTree = tree.stdout.trim();
        }
        if (command.area in conflictStage) {
          const prefix = await runTool(executable, ['rev-parse', '--show-prefix'], {
            cwd: context.root,
            timeoutMs: 10_000,
          });
          const repoPath = `${gitLine(prefix.stdout)}${command.path}`;
          const stage = conflictStage[command.area as keyof typeof conflictStage];
          const stages = await conflictStages(executable, context.root, command.path);
          if (!stages.has(stage))
            return {
              kind: 'diff' as const,
              path: command.path,
              area: command.area,
              text: `No ${command.area} version exists for this conflict stage.`,
              binary: false,
              truncated: false,
              indexTree: null,
            };
          args = literal('show', `:${stage}:${repoPath}`);
        } else if (command.area === 'worktree') {
          const tracked = await runTool(
            executable,
            literal('ls-files', '--error-unmatch', '--', command.path),
            { cwd: context.root, timeoutMs: 10_000 },
          );
          args =
            tracked.code === 0
              ? literal('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', command.path)
              : [
                  '--literal-pathspecs',
                  'diff',
                  '--no-index',
                  '--no-ext-diff',
                  '--no-textconv',
                  '--no-color',
                  '--',
                  process.platform === 'win32' ? 'NUL' : '/dev/null',
                  command.path,
                ];
        } else
          args = literal(
            'diff',
            '--cached',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--',
            command.path,
          );
        const diff = await runTool(executable, args, {
          cwd: context.root,
          timeoutMs: 15_000,
          maxOutputBytes: outputLimit + 1,
        });
        if (command.area in conflictStage) {
          if (diff.code !== 0)
            throw new Error(
              safeGitOutput(diff.output.slice(-500)) || 'Git could not read this conflict stage.',
            );
          const text = diff.stdout.slice(0, outputLimit);
          return {
            kind: 'diff' as const,
            path: command.path,
            area: command.area,
            text,
            binary: text.includes('\0'),
            truncated: diff.stdout.length > outputLimit,
            indexTree: null,
          };
        }
        if (diff.code !== 0 && !(command.area === 'worktree' && diff.code === 1))
          throw new Error('Git could not read this diff. Refresh status and retry.');
        const text = diff.stdout.slice(0, outputLimit);
        if (indexTree) {
          const after = await runTool(executable, ['write-tree'], {
            cwd: context.root,
            timeoutMs: 10_000,
          });
          if (after.code !== 0 || after.stdout.trim() !== indexTree)
            throw new Error(
              'The Git index changed while loading this diff. Refresh and review again.',
            );
        }
        return {
          kind: 'diff' as const,
          path: command.path,
          area: command.area,
          text,
          binary:
            text.includes('\0') ||
            text.includes('Binary files ') ||
            text.includes('GIT binary patch'),
          truncated: diff.stdout.length > outputLimit,
          indexTree,
        };
      }
      if (command.type === 'resolve') {
        const stages = await conflictStages(executable, context.root, command.path);
        if (!stages.size)
          throw new Error(
            'This path is no longer an unresolved merge conflict. Refresh repository status.',
          );
        if (command.choice === 'working') {
          try {
            const content = await fs.readFile(resolve(context.root, command.path));
            if (content.includes(0))
              throw new Error(
                'This is a binary conflict. Choose Use ours or Use theirs to resolve it.',
              );
            const text = content.toString('utf8');
            if (/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(text))
              throw new Error(
                'Conflict markers remain. Edit the file in the source pane, save it, then mark the edited file resolved.',
              );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        } else {
          const selectedStage = command.choice === 'ours' ? '2' : '3';
          if (stages.has(selectedStage)) {
            const checkout = await runTool(
              executable,
              literal(
                'checkout',
                command.choice === 'ours' ? '--ours' : '--theirs',
                '--',
                command.path,
              ),
              { cwd: context.root, timeoutMs: 15_000 },
            );
            if (checkout.code !== 0)
              throw new Error(`Git could not select ${command.choice} for this conflict.`);
          } else await fs.rm(resolve(context.root, command.path), { force: true });
        }
        const add = await runTool(executable, literal('add', '--', command.path), {
          cwd: context.root,
          timeoutMs: 30_000,
        });
        if (add.code !== 0)
          throw new Error(
            'The resolved file could not be added to the Git index. Review the file and retry.',
          );
        return this.command({ type: 'status', projectId: command.projectId });
      }
      if (command.type === 'stage' && privatePath(command.path))
        throw new Error(
          'This path may contain private or generated data. Review and move it outside the project before staging.',
        );
      const result = await runTool(
        executable,
        command.type === 'stage'
          ? literal('add', '--', command.path)
          : await this.unstageArgs(executable, command.path, context.root),
        { cwd: context.root, timeoutMs: 30_000 },
      );
      if (result.code !== 0)
        throw new Error(result.output.slice(-1000) || `Could not ${command.type} this path.`);
      return this.command({ type: 'status', projectId: command.projectId });
    }
    if (command.type === 'commit') {
      const stateBeforeCommit = await this.command({
        type: 'status',
        projectId: command.projectId,
      });
      if (stateBeforeCommit.kind !== 'status' || stateBeforeCommit.truncated)
        throw new Error(
          'Git status is incomplete. Reduce the changed file list before committing.',
        );
      const repoRoot = await runTool(executable, ['rev-parse', '--show-toplevel'], {
        cwd: context.root,
        timeoutMs: 10_000,
      });
      if (repoRoot.code !== 0) throw new Error('Could not inspect the repository root.');
      const tree = await runTool(executable, ['write-tree'], {
        cwd: context.root,
        timeoutMs: 10_000,
      });
      if (tree.code !== 0)
        throw new Error('The Git index is empty or invalid. Stage the files you reviewed first.');
      if (tree.stdout.trim() !== command.expectedIndexTree)
        throw new Error(
          'The staged files changed after review. Refresh and review the current staged diff before committing.',
        );
      const names = await runTool(
        executable,
        ['diff', '--cached', '--name-only', '-z', '--no-renames', '--ignore-submodules=none'],
        {
          cwd: gitLine(repoRoot.stdout),
          timeoutMs: 10_000,
          maxOutputBytes: pathListLimit + 1,
        },
      );
      if (names.code !== 0) throw new Error('Could not inspect the staged file list.');
      if (names.stdout.length > pathListLimit)
        throw new Error(
          'The staged path list is too large to validate safely. Unstage files and retry.',
        );
      const modes = await runTool(
        executable,
        ['diff', '--cached', '--raw', '-z', '--no-renames', '--ignore-submodules=none'],
        {
          cwd: gitLine(repoRoot.stdout),
          timeoutMs: 10_000,
          maxOutputBytes: pathListLimit + 1,
        },
      );
      if (modes.code !== 0 || modes.stdout.length > pathListLimit)
        throw new Error('Could not inspect staged file types safely.');
      if (modes.stdout.split('\0').some((entry) => /^:\d{6} 160000 /.test(entry)))
        throw new Error(
          'Staged Git submodules (gitlinks) cannot be reviewed safely in Loom. Unstage them before committing.',
        );
      const paths = names.stdout.split('\0').filter(Boolean);
      if (!paths.length && !stateBeforeCommit.mergeInProgress)
        throw new Error('There are no staged changes to commit.');
      if (stateBeforeCommit.mergeInProgress) {
        const unresolved = await runTool(executable, ['ls-files', '-u', '-z'], {
          cwd: gitLine(repoRoot.stdout),
          timeoutMs: 10_000,
          maxOutputBytes: pathListLimit + 1,
        });
        if (unresolved.code !== 0 || unresolved.stdout.length)
          throw new Error('Resolve every merge conflict before completing the merge.');
      }
      const prefix = relative(gitLine(repoRoot.stdout), context.root).split(sep).join('/');
      if (prefix && paths.some((path) => !path.startsWith(`${prefix}/`)))
        throw new Error(
          'The index contains staged files outside this project. Unstage them or open the repository root before committing.',
        );
      const unsafe = paths.filter(privatePath);
      if (unsafe.length)
        throw new Error(
          `The existing Git index contains paths that may be private or generated: ${unsafe.slice(0, 5).join(', ')}. Unstage them explicitly, then review again.`,
        );
      const confirmTree = await runTool(executable, ['write-tree'], {
        cwd: context.root,
        timeoutMs: 10_000,
      });
      if (confirmTree.code !== 0 || confirmTree.stdout.trim() !== command.expectedIndexTree)
        throw new Error(
          'The Git index changed during commit review. Refresh the staged diff and retry.',
        );
      const result = await runTool(executable, ['commit', '-m', command.message], {
        cwd: context.root,
        timeoutMs: 120_000,
      });
      if (result.code !== 0)
        throw new Error(
          safeGitOutput(result.output.slice(-1500)) ||
            'Commit failed. Check Git identity, hooks and the staged diff.',
        );
      const state = await this.command({ type: 'status', projectId: command.projectId });
      const committedTree = await runTool(executable, ['rev-parse', 'HEAD^{tree}'], {
        cwd: context.root,
        timeoutMs: 10_000,
      });
      if (state.kind === 'status')
        state.commitNotice =
          committedTree.code === 0 && committedTree.stdout.trim() === command.expectedIndexTree
            ? null
            : 'A Git hook changed the commit contents after review. Inspect the commit before publishing.';
      return state;
    }
    if (command.type === 'fetch' || command.type === 'pull' || command.type === 'push') {
      if (command.type === 'pull' || command.type === 'push') {
        const state = await this.command({ type: 'status', projectId: command.projectId });
        if (state.kind !== 'status' || !state.repository || state.detached)
          throw new Error('This operation needs an attached branch in a Git repository.');
        if (command.type === 'pull' && state.files.length)
          throw new Error(
            'Save or commit the working-tree changes before pull. Loom will not stash or discard them.',
          );
        if (command.type === 'push' && !state.upstream && !command.remote)
          throw new Error('Choose a remote to publish this branch for the first time.');
        if (command.type === 'pull' && !state.upstream)
          throw new Error(
            'No upstream is configured. Configure a tracking branch using Git, then refresh.',
          );
      }
      let args = command.type === 'pull' ? ['pull', '--no-rebase'] : [command.type];
      if (command.type === 'push') {
        args = await this.pushArgs(executable, context.root, command);
      }
      const result = await runTool(executable, args, { cwd: context.root, timeoutMs: 180_000 });
      if (result.code !== 0)
        throw new Error(
          safeGitOutput(result.output.slice(-1800)) ||
            `${command.type} failed. Check network, credentials and repository state.`,
        );
      return this.command({ type: 'status', projectId: command.projectId });
    }
    if (command.type === 'branch') {
      const state = await this.command({ type: 'status', projectId: command.projectId });
      if (state.kind !== 'status' || !state.repository || state.files.length)
        throw new Error('Commit or safely recover all changes before changing branches.');
      const checked = await runTool(executable, ['check-ref-format', '--branch', command.name], {
        cwd: context.root,
        timeoutMs: 10_000,
      });
      if (checked.code !== 0) throw new Error('Enter a valid branch name.');
      const args =
        command.action === 'switch' ? ['switch', command.name] : ['switch', '-c', command.name];
      const result = await runTool(executable, args, { cwd: context.root, timeoutMs: 30_000 });
      if (result.code !== 0)
        throw new Error(safeGitOutput(result.output.slice(-1000)) || 'Branch change failed.');
      return this.command({ type: 'status', projectId: command.projectId });
    }
    throw new Error('Unsupported Git operation.');
  }

  private async unstageArgs(executable: string, path: string, cwd: string): Promise<string[]> {
    const head = await runTool(executable, ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      timeoutMs: 10_000,
    });
    return head.code === 0
      ? literal('restore', '--staged', '--', path)
      : literal('rm', '--cached', '--', path);
  }

  private async pushArgs(
    executable: string,
    cwd: string,
    command: Extract<GitCommand, { type: 'push' }>,
  ): Promise<string[]> {
    const upstream = await runTool(
      executable,
      ['rev-parse', '--symbolic-full-name', '@{upstream}'],
      {
        cwd,
        timeoutMs: 10_000,
      },
    );
    let remote: string;
    let destination: string;
    let setUpstream = false;
    if (upstream.code === 0 && upstream.stdout.trim().startsWith('refs/remotes/')) {
      const trackingRef = upstream.stdout.trim().slice('refs/remotes/'.length);
      const remotes = await runTool(executable, ['remote'], { cwd, timeoutMs: 10_000 });
      remote =
        remotes.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)
          .find((name) => trackingRef.startsWith(`${name}/`)) ?? '';
      if (!remote) throw new Error('Could not identify the current branch upstream remote.');
      destination = `refs/heads/${trackingRef.slice(remote.length + 1)}`;
    } else {
      if (!command.remote) throw new Error('Choose a remote to publish this branch.');
      const remotes = await runTool(executable, ['remote'], { cwd, timeoutMs: 10_000 });
      if (!remotes.stdout.split(/\r?\n/).includes(command.remote))
        throw new Error('Choose a configured Git remote.');
      const branch = await runTool(executable, ['branch', '--show-current'], {
        cwd,
        timeoutMs: 10_000,
      });
      if (branch.code !== 0 || !branch.stdout.trim())
        throw new Error('Switch to an attached branch before publishing.');
      remote = command.remote;
      destination = `refs/heads/${branch.stdout.trim()}`;
      setUpstream = true;
    }
    const mirror = await runTool(
      executable,
      ['config', '--bool', '--get', `remote.${remote}.mirror`],
      {
        cwd,
        timeoutMs: 10_000,
      },
    );
    if (mirror.stdout.trim() === 'true')
      throw new Error(
        'This remote is configured for mirror pushes. Disable mirror mode before publishing from Loom.',
      );
    return [
      'push',
      '--no-force',
      '--no-follow-tags',
      ...(setUpstream ? ['--set-upstream'] : []),
      remote,
      `HEAD:${destination}`,
    ];
  }
}
