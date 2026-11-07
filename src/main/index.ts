import loomIcon from '../../design/brand/loom-app-icon.png?asset';
import { researchCommandSchema } from '../contracts/research';
import { agentCommandSchema } from '../contracts/agent';
import { latexCommandSchema, exportPdfSchema } from '../contracts/latex';
import { writePdfExport } from './pdf-export';
import {
  chooseFileRequestSchema,
  projectCommandSchema,
  projectChoiceSchema,
} from '../contracts/project';
import {
  app,
  shell,
  dialog,
  BrowserWindow,
  ipcMain,
  session,
  utilityProcess,
  type IpcMainInvokeEvent,
} from 'electron';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  channels,
  emptyRequestSchema,
  failure,
  attachmentChoiceSchema,
  type Result,
  type ServiceStatus,
} from '../contracts/desktop';
import { ServiceController } from './service-controller';
import { imageMime } from '../domain/images';
import {
  gitCloneRequestSchema,
  gitCommandSchema,
  sourceExportRequestSchema,
} from '../contracts/git';
import { writeSourceExport } from './source-export';
import { promises as fs } from 'node:fs';

let window: BrowserWindow | undefined;
let closeAllowed = false;
let crashRecoveries = 0;
const service = new ServiceController(
  () => {
    const child = utilityProcess.fork(join(__dirname, 'service.cjs'), [app.getPath('userData')], {
      serviceName: 'Loom local services',
    });
    return {
      postMessage: (message) => child.postMessage(message),
      onMessage: (listener) => {
        child.on('message', listener);
      },
      onExit: (listener) => {
        child.once('exit', listener);
      },
      onError: (listener) => {
        child.once('error', listener);
      },
      kill: () => {
        child.kill();
      },
    };
  },
  5_000,
  (path) => shell.trashItem(path),
);

const rendererFile = join(__dirname, '../renderer/index.html');
const rendererUrl = process.env.ELECTRON_RENDERER_URL || pathToFileURL(rendererFile).href;

function trustedSender(event: IpcMainInvokeEvent): boolean {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false;
  try {
    const sender = new URL(event.senderFrame.url);
    const expected = new URL(rendererUrl);
    return (
      sender.protocol === expected.protocol &&
      sender.host === expected.host &&
      sender.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function handle(channel: string, action: () => Promise<Result<ServiceStatus>>): void {
  ipcMain.handle(channel, (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot access desktop services.', false);
    if (!emptyRequestSchema.safeParse(payload).success)
      return failure('INVALID_REQUEST', 'The desktop request is invalid.', false);
    return action();
  });
}

function createWindow(bounds?: { width: number; height: number }): void {
  window = new BrowserWindow({
    title: 'Loom',
    icon: loomIcon,
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 960,
    minWidth: 720,
    minHeight: 540,
    backgroundColor: '#171717',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const current = window;
  closeAllowed = false;
  current.on('close', (event) => {
    if (!closeAllowed && !current.webContents.isCrashed()) {
      event.preventDefault();
      current.webContents.send(channels.closeRequest, {});
    }
  });
  current.webContents.on('render-process-gone', () => {
    if (current.isDestroyed() || crashRecoveries++ >= 2) return;
    const bounds = current.getBounds();
    createWindow(bounds);
    current.destroy();
  });
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  current.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  current.once('ready-to-show', () => {
    current.show();
  });
  current.once('closed', () => {
    if (window === current) window = undefined;
  });
  if (process.env.ELECTRON_RENDERER_URL) void current.loadURL(rendererUrl);
  else void current.loadFile(rendererFile);
}

void app.whenReady().then(() => {
  app.setName('Loom');
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle(channels.closeReady, (event, payload: unknown) => {
    if (!trustedSender(event) || !emptyRequestSchema.safeParse(payload).success) return;
    closeAllowed = true;
    window?.close();
  });
  handle(channels.status, () => service.getStatus());
  handle(channels.restart, () => service.restart());
  service.subscribe((event) => {
    if (window && !window.isDestroyed()) window.webContents.send(channels.event, event);
  });
  ipcMain.handle(channels.project, (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot access projects.', false);
    const command = projectCommandSchema.safeParse(payload);
    if (!command.success) return failure('INVALID_REQUEST', 'Invalid project command.', false);
    return service.project(command.data);
  });
  ipcMain.handle(channels.agent, (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot access agents.', false);
    const input = agentCommandSchema.safeParse(payload);
    return input.success
      ? service.agent(input.data)
      : failure('INVALID_REQUEST', 'Invalid agent command.', false);
  });
  ipcMain.handle(channels.setup, async (event, guide: unknown) => {
    if (!trustedSender(event)) return;
    if (guide === 'opencode') await shell.openExternal('https://opencode.ai/docs/');
    else if (guide === 'codex')
      await shell.openExternal('https://developers.openai.com/codex/cli/');
    else if (guide === 'tex') await shell.openExternal('https://www.latex-project.org/get/');
    else if (guide === 'texlab')
      await shell.openExternal('https://github.com/latex-lsp/texlab#installation');
  });
  ipcMain.handle(channels.latex, (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot use LaTeX services.', false);
    const command = latexCommandSchema.safeParse(payload);
    if (!command.success) return failure('INVALID_REQUEST', 'Invalid LaTeX command.', false);
    return service.latex(command.data);
  });
  ipcMain.handle(channels.git, (event, payload: unknown) => {
    if (!trustedSender(event)) return failure('FORBIDDEN', 'This window cannot access Git.', false);
    const command = gitCommandSchema.safeParse(payload);
    return command.success
      ? service.git(command.data)
      : failure('INVALID_REQUEST', 'Invalid Git request.', false);
  });
  ipcMain.handle(channels.cloneGit, async (event, payload: unknown) => {
    if (!trustedSender(event))
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'This window cannot clone repositories.',
          retryable: false,
        },
      };
    const input = gitCloneRequestSchema.safeParse(payload);
    if (!input.success)
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message:
            'Use an HTTPS or SSH Git remote without embedded credentials, or a local file URL.',
          retryable: false,
        },
      };
    if (choosing)
      return {
        ok: false,
        error: { code: 'BUSY', message: 'A native dialog is already open.', retryable: true },
      };
    choosing = true;
    try {
      const selected = await dialog.showOpenDialog(window!, {
        title: 'Choose where to clone the repository',
        buttonLabel: 'Choose parent folder',
        defaultPath: service.projectLocation?.path,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (selected.canceled || !selected.filePaths[0]) return { ok: true, value: null };
      let repositoryName = '';
      try {
        const url = new URL(input.data.url);
        repositoryName = basename(url.pathname.replace(/\/$/, '')).replace(/\.git$/i, '');
      } catch {
        repositoryName = basename(input.data.url.slice(input.data.url.indexOf(':') + 1)).replace(
          /\.git$/i,
          '',
        );
      }
      if (
        !/^[\p{L}\p{N}._-]{1,100}$/u.test(repositoryName) ||
        repositoryName === '.' ||
        repositoryName === '..'
      )
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'The remote does not have a safe repository folder name.',
            retryable: false,
          },
        };
      const parent = await fs.realpath(selected.filePaths[0]);
      const destination = join(parent, repositoryName);
      try {
        await fs.lstat(destination);
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: `The destination ${repositoryName} already exists. Choose another parent folder.`,
            retryable: false,
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return await service.project({ type: 'native-git-clone', url: input.data.url, destination });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'GIT_ERROR',
          message:
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'Git clone failed. Check the destination and retry.',
          retryable: true,
        },
      };
    } finally {
      choosing = false;
    }
  });
  ipcMain.handle(channels.exportSource, async (event, payload: unknown) => {
    if (!trustedSender(event))
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'This window cannot export project sources.',
          retryable: false,
        },
      };
    const input = sourceExportRequestSchema.safeParse(payload);
    if (!input.success)
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Refresh publication preflight before exporting.',
          retryable: false,
        },
      };
    if (choosing)
      return {
        ok: false,
        error: { code: 'BUSY', message: 'A native dialog is already open.', retryable: true },
      };
    choosing = true;
    try {
      const current = await service.project({ type: 'refresh' });
      const location = service.projectLocation;
      if (
        !current.ok ||
        !current.value ||
        current.value.id !== input.data.projectId ||
        location?.projectId !== input.data.projectId
      )
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'The project changed. Refresh preflight before exporting.',
            retryable: true,
          },
        };
      if (current.value.sourceRevision !== input.data.revision)
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Project files changed after preflight. Refresh the review before exporting.',
            retryable: true,
          },
        };
      const archive = await service.git({
        type: 'archive',
        projectId: input.data.projectId,
        expectedRevision: input.data.revision,
      });
      if (!archive.ok) return archive;
      if (archive.value.kind !== 'archive')
        return {
          ok: false,
          error: {
            code: 'INVALID_RESPONSE',
            message: 'The source archive service returned an invalid result.',
            retryable: true,
          },
        };
      const selected = await dialog.showSaveDialog(window!, {
        title: 'Export portable LaTeX source',
        buttonLabel: 'Export source ZIP',
        defaultPath: 'paper-source.zip',
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      });
      if (selected.canceled || !selected.filePath)
        return {
          ok: true,
          value: {
            cancelled: true,
            included: archive.value.included.length,
            excluded: archive.value.excluded.length,
          },
        };
      const latest = await service.project({ type: 'refresh' });
      if (
        !latest.ok ||
        latest.value?.id !== input.data.projectId ||
        latest.value.sourceRevision !== input.data.revision
      )
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message:
              'Project files changed while the save dialog was open. Refresh preflight and try again.',
            retryable: true,
          },
        };
      await writeSourceExport(selected.filePath, archive.value.bytes, {
        root: location.path,
        paths: latest.value.files.map((file) => file.path),
      });
      return {
        ok: true,
        value: {
          cancelled: false,
          included: archive.value.included.length,
          excluded: archive.value.excluded.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'EXPORT_ERROR',
          message:
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'Source export failed. Check the destination and retry.',
          retryable: true,
        },
      };
    } finally {
      choosing = false;
    }
  });
  ipcMain.handle(channels.research, async (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot access references.', false);
    const command = researchCommandSchema.safeParse(payload);
    if (!command.success) return failure('INVALID_REQUEST', 'Invalid reference request.', false);
    return service.research(command.data);
  });
  ipcMain.handle(channels.openSource, async (event, payload: unknown) => {
    if (!trustedSender(event) || typeof payload !== 'string' || payload.length > 2000) return;
    try {
      const url = new URL(payload);
      if (url.protocol === 'https:' && !url.username && !url.password)
        await shell.openExternal(url.href);
    } catch {
      /* Untrusted record URL. */
    }
  });
  ipcMain.handle(channels.exportPdf, async (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot export PDFs.', false);
    const input = exportPdfSchema.safeParse(payload);
    if (!input.success) return failure('INVALID_REQUEST', 'Invalid PDF export.', false);
    if (choosing) return failure('BUSY', 'A native dialog is already open.');
    choosing = true;
    try {
      const pdf = await service.latex({
        type: 'pdf',
        projectId: input.data.projectId,
        buildId: input.data.buildId,
      });
      if (!pdf.ok || pdf.value.kind !== 'pdf') return pdf;
      const current = await service.project({ type: 'refresh' });
      const location = service.projectLocation;
      if (!current.ok) return current;
      if (
        !current.value ||
        current.value.id !== input.data.projectId ||
        location?.projectId !== input.data.projectId
      )
        return failure('INVALID_REQUEST', 'The project changed. Retry PDF export.', false);
      const older = input.data.stale || pdf.value.revision !== current.value.sourceRevision;
      const selected = await dialog.showSaveDialog(window!, {
        title: older ? 'Export older PDF — source has changed' : 'Export compiled PDF',
        defaultPath: older ? 'paper-older-build.pdf' : 'paper.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (selected.canceled || !selected.filePath)
        return { ok: true, value: { kind: 'export', cancelled: true } };
      const latest = await service.project({ type: 'refresh' });
      if (!latest.ok) return latest;
      if (
        latest.value?.id !== current.value.id ||
        latest.value.sourceRevision !== current.value.sourceRevision
      )
        return failure(
          'INVALID_REQUEST',
          'Source changed while choosing the destination. Retry export to identify the older PDF.',
          true,
        );
      await writePdfExport(selected.filePath, Buffer.from(pdf.value.data, 'base64'), {
        root: location.path,
        paths: latest.value.files.filter((f) => !f.deleted).map((f) => f.path),
      });
      return { ok: true, value: { kind: 'export', cancelled: false } };
    } catch (error) {
      return failure(
        'INVALID_REQUEST',
        error instanceof Error
          ? error.message
          : 'PDF could not be exported. Check the destination and retry.',
      );
    } finally {
      choosing = false;
    }
  });
  let choosing = false;
  ipcMain.handle(channels.chooseAttachments, async (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot select attachments.', false);
    const input = attachmentChoiceSchema.safeParse(payload);
    if (!input.success) return failure('INVALID_REQUEST', 'Invalid attachment choice.', false);
    if (choosing) return failure('BUSY', 'A file selector is already open.');
    choosing = true;
    try {
      const current = await service.project({ type: 'current' });
      const location = service.projectLocation;
      if (
        !current.ok ||
        !current.value ||
        !location ||
        current.value.id !== input.data.projectId ||
        location.projectId !== input.data.projectId
      )
        return failure('INVALID_REQUEST', 'Open a paper before attaching files.', false);
      const selected = await dialog.showOpenDialog(window!, {
        title: 'Attach paper files or import images',
        buttonLabel: 'Attach',
        defaultPath: location.path,
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Paper files and images',
            extensions: [
              'tex',
              'bib',
              'txt',
              'md',
              'csv',
              'tsv',
              'json',
              'sty',
              'cls',
              'png',
              'jpg',
              'jpeg',
              'webp',
              'gif',
            ],
          },
        ],
      });
      if (selected.canceled) return { ok: true, value: { cancelled: true, paths: [] } };
      const selectedPaths = [...new Set(selected.filePaths)];
      if (selectedPaths.length > (input.data.limit ?? 20))
        return failure(
          'INVALID_REQUEST',
          'The selection exceeds the remaining attachment limit.',
          false,
        );
      const choices = selectedPaths.map((source) => {
        const rel = relative(location.path, source);
        const outside = !rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
        return { source, outside, path: rel.split(sep).join('/') };
      });
      if (
        choices.some((choice) => {
          if (!isAbsolute(choice.source)) return true;
          if (choice.outside) return !imageMime(choice.source);
          return !current.value!.files.some(
            (file) =>
              file.path === choice.path &&
              !file.deleted &&
              (file.diskKind === 'text' || (file.diskKind === 'binary' && imageMime(choice.path))),
          );
        })
      )
        return failure(
          'INVALID_REQUEST',
          'Choose text files inside this paper folder or supported images.',
          false,
        );
      const paths: string[] = [],
        imported: string[] = [];
      for (const choice of choices) {
        if (!choice.outside) {
          paths.push(choice.path);
          continue;
        }
        const extension = extname(choice.source).slice(1).toLowerCase();
        const label =
          Array.from(
            basename(choice.source, extname(choice.source)).replace(/[^\p{L}\p{N}_-]+/gu, '-'),
          )
            .slice(0, 36)
            .join('')
            .replace(/^-+|-+$/g, '') || 'image';
        const path = `loom-import-${randomUUID().replace(/-/g, '').slice(0, 12)}-${label}.${extension}`;
        const result = await service.project({
          type: 'native-import-image',
          projectId: input.data.projectId,
          source: choice.source,
          path,
        });
        if (!result.ok) {
          const saved = imported.length
            ? ` Already copied: ${imported.slice(0, 3).join(', ')}${imported.length > 3 ? ` and ${imported.length - 3} more` : ''}.`
            : '';
          return failure(
            'INVALID_REQUEST',
            `Could not finish importing an image. Check its format, size and the open paper; check whether ${path} was copied.${saved}`,
            false,
          );
        }
        paths.push(path);
        imported.push(path);
      }
      return { ok: true, value: { cancelled: false, paths, imported: imported.length } };
    } catch {
      return failure(
        'INVALID_REQUEST',
        'The file selector could not open. Try attaching files again.',
      );
    } finally {
      choosing = false;
    }
  });
  ipcMain.handle(channels.chooseFile, async (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot create project files.', false);
    const input = chooseFileRequestSchema.safeParse(payload);
    if (!input.success) return failure('INVALID_REQUEST', 'Invalid file choice.', false);
    if (choosing) return failure('BUSY', 'A file dialog is already open.');
    choosing = true;
    try {
      const current = await service.project({ type: 'current' });
      if (!current.ok) return current;
      const location = service.projectLocation;
      if (
        !location ||
        current.value?.id !== input.data.projectId ||
        location.projectId !== input.data.projectId
      )
        return failure('INVALID_REQUEST', 'Open the project before creating a file.', false);
      const selected = await dialog.showSaveDialog(window!, {
        title: 'Create new file',
        buttonLabel: 'Create file',
        defaultPath: join(location.path, input.data.directory ?? '', 'untitled.tex'),
      });
      if (selected.canceled || !selected.filePath) return { ok: true, value: null };
      return service.project({
        type: 'native-create-file',
        path: selected.filePath,
        projectId: input.data.projectId,
      });
    } catch {
      return failure('SERVICE_UNAVAILABLE', 'The file dialog could not open. Try again.');
    } finally {
      choosing = false;
    }
  });
  ipcMain.handle(channels.chooseProject, async (event, payload: unknown) => {
    if (!trustedSender(event))
      return failure('FORBIDDEN', 'This window cannot choose projects.', false);
    const choice = projectChoiceSchema.safeParse(payload);
    if (!choice.success) return failure('INVALID_REQUEST', 'Invalid project choice.', false);
    if (choosing) return failure('BUSY', 'A project dialog is already open.');
    choosing = true;
    try {
      if (choice.data === 'main-folder') {
        const location = service.projectLocation;
        if (!location) return failure('INVALID_REQUEST', 'Open a paper first.', false);
        return service.project({ type: 'native-main-folder', projectId: location.projectId });
      }
      const samples: Record<string, [string, string]> = {
        sample: ['multi-file', 'Sample paper'],
        'sample-biber': ['biber', 'References with Biber'],
        'sample-bibtex': ['bibtex', 'References with BibTeX'],
        'sample-ambiguous': ['ambiguous', 'Choose a paper'],
        'sample-broken': ['broken', 'Practice fixing an error'],
        'sample-missing-package': ['missing-package', 'Missing package example'],
      };
      const sample = samples[choice.data];
      if (sample)
        return service.project({
          type: 'native-sample',
          path: join(
            app.isPackaged ? process.resourcesPath : join(__dirname, '../..'),
            'examples/phase-3',
            sample[0],
          ),
          destination: join(app.getPath('userData'), 'sample-papers', sample[1]),
        });
      if (choice.data === 'create') {
        const selected = await dialog.showSaveDialog(window!, {
          title: 'Create project folder',
          buttonLabel: 'Create project',
        });
        if (selected.canceled || !selected.filePath) return { ok: true, value: null };
        return service.project({ type: 'native-create', path: selected.filePath });
      }
      const selected = await dialog.showOpenDialog(window!, {
        title: choice.data === 'import-zip' ? 'Import project ZIP' : 'Choose project folder',
        properties: choice.data === 'import-zip' ? ['openFile'] : ['openDirectory'],
        ...(choice.data === 'import-zip'
          ? { filters: [{ name: 'ZIP archive', extensions: ['zip'] }] }
          : {}),
      });
      if (selected.canceled) return { ok: true, value: null };
      if (choice.data === 'open')
        return service.project({ type: 'native-open', path: selected.filePaths[0] });
      const target = await dialog.showSaveDialog(window!, {
        title: 'New imported project folder',
        buttonLabel: 'Import project',
      });
      if (target.canceled || !target.filePath) return { ok: true, value: null };
      return service.project({
        type: `native-${choice.data}`,
        path: selected.filePaths[0],
        destination: target.filePath,
      });
    } finally {
      choosing = false;
    }
  });
  void service.start();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  service.stop();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
