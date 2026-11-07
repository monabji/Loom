import { defaultBuildSettings, type BuildState } from '../../src/contracts/latex';
import { resumeFromLibrary } from './helpers/project-library';
import { electronLaunchOptions } from './helpers/launch';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
let app: ElectronApplication, page: Page, directory: string, root: string;
async function launch() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  app = await _electron.launch({
    ...electronLaunchOptions(process.env, [`--user-data-dir=${join(directory, 'data')}`]),
    env,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const result = await window.loom!.getStatus();
        return result.ok && result.value.state;
      }),
    )
    .toBe('ready');
  if ((await page.locator('.library-project').count()) > 0) await resumeFromLibrary(page);
}
async function openExample(name = 'multi-file') {
  root = join(directory, name + ' 论文');
  await cp(resolve(`examples/phase-3/${name}`), root, { recursive: true });
  // Personal settings in the working sample must not change the isolated baseline.
  if (name === 'multi-file') await rm(join(root, 'loom.build.json'), { force: true });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, root);
  await page
    .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Open folder', exact: true })
    .click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Projects', exact: true })).not.toBeVisible();
}
async function waitPdf() {
  await expect(page.locator('.build-status')).toHaveText('PDF ready', { timeout: 25000 });
  await expect
    .poll(() =>
      page.locator('.pdf-sheet canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width),
    )
    .toBeGreaterThan(0);
  await expect(page.locator('.pdf-load-status')).toContainText('Select text', { timeout: 15000 });
  await expect(page.locator('.textLayer span').first()).toBeAttached();
}
async function dimensions(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      const [ow, oh] = window.getSize(),
        [cw, ch] = window.getContentSize();
      window.setMaximumSize(0, 0);
      window.setMinimumSize(size.width + ow - cw, size.height + oh - ch);
      window.setMaximumSize(size.width + ow - cw, size.height + oh - ch);
      window.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'loom-latex-e2e-'));
  await launch();
});
test.afterEach(async () => {
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
      })
      .catch(() => {});
    await app.close();
  }
  await rm(directory, { recursive: true, force: true });
});

test('static branding and dismissible PDF guidance survive polling and show new failures', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dimensions(1440, 960);
  // Install the replay before opening: no real initial status response may race it.
  await app.evaluate(({ ipcMain }, settings) => {
    let state: BuildState | null = null;
    ipcMain.removeHandler('loom:latex:command');
    ipcMain.handle('loom:latex:command', (_event, command) => ({
      ok: true,
      value: {
        kind: 'state',
        state: state ?? {
          projectId: command.projectId,
          settings,
          tools: [],
          current: null,
          successful: null,
          queued: false,
        },
      },
    }));
    ipcMain.on('test:build-state', (_event, next: BuildState) => {
      state = next;
    });
    ipcMain.on('test:next-build', () => {
      state!.current!.id = 'synthetic-failure-2';
    });
  }, defaultBuildSettings);
  await openExample();
  await expect(page.locator('.sidebar-brand .loom-logo')).toBeVisible();
  await expect(page.locator('.sidebar-brand button.wordmark')).toHaveCount(0);
  const project = await page.evaluate(async () => {
    const result = await window.loom!.project({ type: 'current' });
    if (!result.ok || !result.value) throw new Error('Missing project');
    return result.value;
  });
  const state: BuildState = {
    projectId: project.id,
    settings: defaultBuildSettings,
    tools: [],
    // Keep the real status polling path active while replaying failure snapshots.
    queued: true,
    successful: null,
    current: {
      id: 'synthetic-failure-1',
      projectId: project.id,
      revision: project.sourceRevision!,
      root: project.files.find((file) => file.id === project.rootId)!.path,
      settings: defaultBuildSettings,
      status: 'failed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      log: './main.tex:7: Undefined control sequence.',
      diagnostics: [
        {
          path: 'main.tex',
          line: 7,
          column: 0,
          severity: 'error',
          message: 'Undefined control sequence.',
        },
      ],
      tools: [],
      hasPdf: false,
      hasSynctex: false,
    },
  };
  await app.evaluate(({ ipcMain }, state) => {
    ipcMain.emit('test:build-state', null, state);
  }, state);
  await page.locator('.compile-source').click();
  const guidance = page.getByRole('status', { name: 'PDF guidance' });
  await expect(guidance).toContainText('LaTeX did not recognise a command');
  const dismiss = guidance.getByRole('button', { name: 'Dismiss PDF guidance' });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(guidance).toBeHidden();
  await expect(page.locator('.build-status')).toBeFocused();
  // A fresh status response must not resurrect the dismissed build's message.
  await page.waitForTimeout(1500);
  await expect(guidance).toBeHidden();
  await expect(page.locator('.build-status')).toHaveText('PDF needs attention');
  await page.locator('.build-status').click();
  await expect(page.getByRole('dialog', { name: 'PDF settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await app.evaluate(({ ipcMain }) => {
    ipcMain.emit('test:next-build');
  });
  await expect(guidance).toBeVisible();
  await page.screenshot({ path: 'artifacts/pdf-guidance-dismissible-wide.png' });
  await dimensions(720, 540);
  await page.getByRole('button', { name: 'Show PDF preview', exact: true }).click();
  await expect(dismiss).toBeVisible();
  await page.screenshot({ path: 'artifacts/pdf-guidance-dismissible-small.png' });
  await dismiss.click();
  await expect(guidance).toBeHidden();
});

test('missing-tool build setup remains honest and source stays editable', async () => {
  test.skip(
    process.env.LOOM_TEST_TEX === '1',
    'This case exercises the machine without the optional live toolchain.',
  );
  await dimensions(1440, 960);
  await app.evaluate(() => {
    process.env.LOOM_TEX_PATH = '/loom-acceptance-empty-tool-path';
  });
  await page.evaluate(() => window.loom!.restartService());
  await openExample();
  await page.locator('.compile-source').click();
  const modal = page.getByRole('dialog', { name: 'PDF settings' });
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole('heading', { name: 'Set up PDF creation on this computer' }),
  ).toBeVisible();
  await expect(modal.getByRole('button', { name: 'LaTeX installation guide' })).toBeVisible();
  await expect(modal.getByLabel('LaTeX engine', { exact: true })).not.toBeVisible();
  await modal.getByRole('button', { name: 'Close dialog' }).click();
  await page.locator('.cm-content').press('Control+End');
  await page.locator('.cm-content').pressSequentially('% still editable');
  await expect.poll(() => readFile(join(root, 'main.tex'), 'utf8')).toContain('% still editable');
});

test.describe('live Phase 3 Electron workflow', () => {
  test.skip(
    process.env.LOOM_TEST_TEX !== '1',
    'Requires the explicit authorized local TeX/TexLab setup.',
  );
  test('a researcher opens a built-in sample, edits, updates and downloads without setup forms', async () => {
    await dimensions(1600, 1000);
    await page.getByRole('button', { name: 'Try a sample paper', exact: true }).click();
    await waitPdf();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.locator('.document-tabs button[aria-pressed="true"]')).toContainText(
      'introduction.tex',
    );
    await expect(page.getByText('Try a small change', { exact: true })).toBeVisible();
    await page.locator('.cm-content').press('Control+End');
    await page.locator('.cm-content').pressSequentially('\nA new observation from our study.\n');
    await expect(page.locator('.build-status')).toHaveText('Changes not in PDF');
    await page.locator('.compile-source').click();
    await waitPdf();
    await expect(page.locator('.textLayer')).toContainText('new observation');
    await page.locator('.build-status').click();
    const settings = page.getByRole('dialog', { name: 'PDF settings' });
    await expect(settings.getByLabel('LaTeX engine', { exact: true })).not.toBeVisible();
    await expect(settings.getByText('Full LaTeX log', { exact: true })).not.toBeVisible();
    await settings.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await page.screenshot({ path: 'artifacts/phase-3-ux-settings.png' });
    await settings.getByText('Advanced settings', { exact: true }).click();
    await settings.getByLabel('LaTeX engine', { exact: true }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await settings.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Got it', exact: true }).click();
    await page.screenshot({ path: 'artifacts/phase-3-ux-workspace.png' });
    const destination = join(directory, 'shared-paper.pdf');
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, destination);
    await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
    await expect
      .poll(() =>
        readFile(destination)
          .then((bytes) => bytes.subarray(0, 5).toString())
          .catch(() => ''),
      )
      .toBe('%PDF-');
    await dimensions(900, 700);
    await page.getByRole('button', { name: 'Show PDF preview', exact: true }).click();
    await expect(page.locator('.pdf-viewer')).toBeVisible();
    await waitPdf();
    await page.screenshot({ path: 'artifacts/phase-3-ux-small.png' });
  });
  test('explains the parent-folder failure and opens the correct paper with one recovery action', async () => {
    await dimensions(1440, 960);
    root = join(directory, 'collection');
    await cp(resolve('examples/phase-3/multi-file'), join(root, 'multi-file'), { recursive: true });
    // This manual-recovery fixture must not inherit a developer's local auto-build preference.
    await rm(join(root, 'multi-file', 'loom.build.json'), { force: true });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, root);
    await page
      .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Projects', exact: true })
      .getByRole('button', { name: 'Open folder', exact: true })
      .click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.locator('.compile-source').click();
    // A labelled section with role=status is located by its accessible label.
    await expect(page.locator('.pdf-column .pdf-feedback')).toContainText(
      'Open the folder for this paper',
    );
    await expect(page.locator('.pdf-column .pdf-feedback')).toContainText(
      'sections/introduction.tex',
    );
    await page.screenshot({ path: 'artifacts/phase-3-ux-recovery.png' });
    await page.getByRole('button', { name: 'Open paper folder', exact: true }).click();
    await waitPdf();
    await expect(page.locator('.project-selector')).toContainText('multi-file');
    await expect(page.locator('.pdf-column .pdf-feedback')).not.toBeVisible();
    // A child folder's portable settings must not silently replace the user's chosen paper.
    await writeFile(
      join(root, 'multi-file', 'other.tex'),
      '\\documentclass{article}\n\\begin{document}\\UnknownSampleCommand\\end{document}',
    );
    await writeFile(
      join(root, 'multi-file', 'loom.build.json'),
      JSON.stringify({
        version: 1,
        root: 'other.tex',
        settings: {
          engine: 'pdflatex',
          bibliography: 'auto',
          recipe: 'latexmk',
          autoBuild: false,
          delayMs: 1500,
        },
      }),
    );
    await page.evaluate(() => window.loom!.project({ type: 'refresh' }));
    await page.locator('.compile-source').click();
    await expect(page.locator('.build-status')).toHaveText('PDF needs attention');
    await writeFile(
      join(root, 'multi-file', 'main.tex'),
      (await readFile(join(root, 'multi-file', 'main.tex'), 'utf8')) + '\n% A later revision\n',
    );
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Projects', exact: true })
      .getByRole('button', { name: 'Open folder', exact: true })
      .click();
    await page.locator('.compile-source').click();
    await page.getByRole('button', { name: 'Open paper folder', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'PDF settings' });
    await expect(settings).toContainText('saved settings for a different paper');
    await settings.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(settings.getByLabel('Main document', { exact: true })).toHaveValue('');
    const prior = await page.evaluate(async () => {
      const project = await window.loom!.project({ type: 'current' });
      if (!project.ok || !project.value) throw new Error('Missing project');
      const state = await window.loom!.latex({ type: 'status', projectId: project.value.id });
      return state.ok && state.value.kind === 'state' ? state.value.state.current?.id : null;
    });
    await page.keyboard.press('Escape');
    await page.locator('.cm-content').press('Control+Shift+b');
    await expect(
      page.locator('.project-error').filter({ hasText: 'Choose the main document' }),
    ).toBeVisible();
    await page.locator('.compile-source').click();
    await expect(settings).toBeVisible();
    const after = await page.evaluate(async () => {
      const project = await window.loom!.project({ type: 'current' });
      if (!project.ok || !project.value) throw new Error('Missing project');
      const state = await window.loom!.latex({ type: 'status', projectId: project.value.id });
      return state.ok && state.value.kind === 'state' ? state.value.state.current?.id : null;
    });
    expect(after).toBe(prior);
    const main = settings.getByLabel('Main document', { exact: true });
    await expect(main).toHaveValue('');
    const value = await main
      .locator('option')
      .filter({ hasText: /^main.tex$/ })
      .getAttribute('value');
    await main.selectOption(value!);
    await settings.getByRole('button', { name: /^(Create|Update) PDF$/, exact: true }).click();
    await waitPdf();
  });
  test('sample library asks for a main document and makes package errors actionable', async () => {
    await dimensions(1440, 960);
    await page
      .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
      .click();
    await page.getByText('More sample papers', { exact: true }).click();
    await page.getByRole('button', { name: /Choose between two papers/ }).click();
    const settings = page.getByRole('dialog', { name: 'PDF settings' });
    await expect(settings.getByLabel('Main document', { exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Create PDF', exact: true })).toBeDisabled();
    const first = await settings
      .getByLabel('Main document', { exact: true })
      .locator('option')
      .nth(1)
      .getAttribute('value');
    await settings.getByLabel('Main document', { exact: true }).selectOption(first!);
    await settings.getByRole('button', { name: 'Create PDF', exact: true }).click();
    await waitPdf();
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('button', { name: /Missing package example/ }).click();
    await expect(page.locator('.pdf-column .pdf-feedback')).toContainText(
      'A style or package could not be found',
    );
    await expect(page.locator('.pdf-column .pdf-feedback')).toContainText(
      'loom-synthetic-package-that-does-not-exist',
    );
  });
  test('renders a real PDF with text, pages, zoom, snapshot mapping and native export', async () => {
    await dimensions(1600, 1000);
    await openExample();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.compile-source').click();
    await waitPdf();
    expect(await page.locator('.pdf-sheet canvas').count()).toBe(1);
    await page.getByRole('button', { name: 'Next PDF page' }).click();
    await expect(page.getByRole('spinbutton', { name: 'PDF page number' })).toHaveValue('2');
    await expect(page.locator('.pdf-load-status')).toContainText('Select text');
    await expect(page.locator('.textLayer')).toContainText('Results');
    await page.getByRole('combobox', { name: 'PDF zoom' }).selectOption('1.5');
    await expect(page.locator('.pdf-load-status')).toContainText('Select text');
    // PDF.js text selection is native DOM selection, not a screenshot of a paper.
    const selected = await page.locator('.textLayer').evaluate((layer) => {
      const range = document.createRange();
      range.selectNodeContents(layer);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(selected).toContain('Results');
    await page.getByRole('combobox', { name: 'PDF zoom' }).selectOption('1');
    await page.getByRole('spinbutton', { name: 'PDF page number' }).fill('1');
    await page.getByRole('spinbutton', { name: 'PDF page number' }).press('Enter');
    await expect(page.locator('.pdf-load-status')).toContainText('Select text');
    // The mapped passage comes from a real text-layer glyph position.
    const passage = page
      .locator('.textLayer span')
      .filter({ hasText: 'synthetic manuscript' })
      .first();
    await expect(passage).toBeVisible();
    await passage.dblclick();
    await expect(page.locator('.document-tabs button[aria-pressed="true"]')).toContainText(
      'introduction.tex',
    );
    await page.getByRole('button', { name: 'More workspace actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Scientific tools', exact: true }).click();
    await page.getByRole('button', { name: 'Show in PDF', exact: true }).click();
    await expect(page.locator('.pdf-source-marker')).toBeAttached();
    const destination = join(directory, 'export.pdf');
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, destination);
    await page.getByRole('button', { name: 'Download PDF' }).click();
    await expect
      .poll(() =>
        readFile(destination)
          .then((bytes) => bytes.subarray(0, 5).toString())
          .catch(() => ''),
      )
      .toBe('%PDF-');
    await page.screenshot({ path: 'artifacts/phase-3-workspace.png' });
    const sourceBeforeExport = await readFile(join(root, 'main.tex'), 'utf8');
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      },
      join(root, 'main.tex'),
    );
    await page.getByRole('button', { name: 'Download PDF' }).click();
    await expect(
      page.locator('.project-error').filter({ hasText: 'Choose a .pdf filename' }),
    ).toBeVisible();
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe(sourceBeforeExport);
    expect(errors).toEqual([]);
  });
  test('retains last successful PDF after failure, marks unsaved/external inputs stale and restores after restart', async () => {
    await dimensions(1440, 960);
    await openExample();
    await page.locator('.compile-source').click();
    await waitPdf();
    await page.getByRole('button', { name: 'Next PDF page' }).click();
    await expect(page.getByRole('spinbutton', { name: 'PDF page number' })).toHaveValue('2');
    const content = page.locator('.cm-content');
    await content.press('Control+Home');
    await content.pressSequentially('\\LoomUndefinedCommand');
    await content.press('Enter');
    await expect(page.locator('.build-status')).toHaveText('Changes not in PDF');
    await expect(page.getByRole('button', { name: 'Show source', exact: true })).toBeDisabled();
    await page.locator('.compile-source').click();
    await expect(page.locator('.build-status')).toHaveText('PDF needs attention');
    await expect(page.locator('.pdf-sheet canvas')).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'PDF page number' })).toHaveValue('2');
    await page.locator('.build-status').click();
    const modal = page.getByRole('dialog', { name: 'PDF settings' });
    await modal.getByText('Technical details', { exact: true }).click();
    await modal.getByText('Full LaTeX log', { exact: true }).click();
    await expect(
      modal.locator('pre').filter({ hasText: 'Undefined control sequence' }),
    ).toBeVisible();
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await page.evaluate(() => window.loom!.restartService());
    await expect(page.locator('.pdf-sheet canvas')).toBeVisible();
    await expect(page.locator('.build-status')).toHaveText('PDF needs attention');
    await page.screenshot({ path: 'artifacts/phase-3-failed-build.png' });
  });
  test('TexLab completion, definition, diagnostics and project structure work through the live editor', async () => {
    await dimensions(1440, 960);
    await openExample();
    await page
      .locator('.project-panel')
      .getByRole('button', { name: 'sections/introduction.tex', exact: true })
      .click();
    const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
    await editor.press('Control+End');
    await editor.press('Enter');
    await editor.pressSequentially('\\ref{sec:i');
    await editor.press('Control+Space');
    const option = page.getByRole('option').filter({ hasText: 'sec:introduction' }).first();
    await expect(option).toBeVisible();
    await option.click();
    await editor.pressSequentially('}');
    await expect
      .poll(() => readFile(join(root, 'sections/introduction.tex'), 'utf8'))
      .toContain('\\ref{sec:introduction}');
    await editor.press('ArrowLeft');
    await editor.press('F12');
    await expect(page.locator('.cm-activeLine')).toContainText('Introduction');
    await editor.press('Control+End');
    await editor.press('Enter');
    await editor.pressSequentially('\\begin{unclosed');
    await expect(
      page.locator('.cm-lintRange-error, .cm-lintPoint-error, .cm-lint-marker-error').first(),
    ).toBeAttached({ timeout: 15000 });
    await page.getByText('Project structure', { exact: true }).click();
    await page
      .locator('.project-structure')
      .getByRole('button')
      .filter({ hasText: 'sec:results' })
      .click();
    await expect(page.locator('.document-tabs button[aria-pressed="true"]')).toContainText(
      'results.tex',
    );
  });
  test('cancels a real long TeX process and recovers an interrupted utility without orphan tools', async () => {
    test.setTimeout(60000);
    await dimensions(1440, 960);
    await openExample();
    await page.locator('.compile-source').click();
    await waitPdf();
    const original = await readFile(join(root, 'main.tex'), 'utf8');
    const slow = original.replace(
      '\\begin{document}',
      '\\begin{document}\n\\newcount\\loomcounter\n\\loop\\ifnum\\loomcounter<100000000\n\\advance\\loomcounter by 1\n\\repeat\n',
    );
    await writeFile(join(root, 'main.tex'), slow);
    await expect(page.locator('.build-status')).toHaveText('Changes not in PDF');
    const processes = async () =>
      (await promisify(execFile)('ps', ['-eo', 'pid,args'])).stdout
        .split('\n')
        .filter(
          (line) => line.includes(join(directory, 'data', 'builds')) && /latexmk|pdftex/.test(line),
        );
    await page.locator('.compile-source').click();
    await expect.poll(processes).not.toEqual([]);
    await page.locator('.build-status').click();
    const modal = page.getByRole('dialog', { name: 'PDF settings' });
    await modal.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(
      modal.getByRole('heading', { name: 'PDF creation stopped', exact: true }).first(),
    ).toBeVisible();
    await expect.poll(processes).toEqual([]);
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await expect(page.locator('.pdf-sheet canvas')).toBeVisible();
    await page.locator('.compile-source').click();
    await expect.poll(processes).not.toEqual([]);
    const status = await page.evaluate(() => window.loom!.getStatus());
    if (!status.ok || !status.value.pid) throw new Error('service unavailable');
    process.kill(status.value.pid, 'SIGKILL');
    await expect.poll(processes).toEqual([]);
    await page.evaluate(() => window.loom!.restartService());
    await expect(page.locator('.build-status')).toHaveText('PDF creation interrupted');
    await expect(page.locator('.pdf-sheet canvas')).toBeVisible();
  });
  test('continuous typing with slow save acknowledgements stays quiet and updates after a pause', async () => {
    await dimensions(1440, 960);
    await openExample();
    await page.locator('.build-status').click();
    const modal = page.getByRole('dialog', { name: 'PDF settings' });
    await expect(modal.getByLabel('Update the PDF as I write')).toBeEnabled();
    await modal.getByLabel('Update the PDF as I write').check();
    await modal.getByText('Advanced settings', { exact: true }).click();
    await modal.getByLabel('Pause before updating (seconds)').fill('0.75');
    await modal.getByRole('button', { name: 'Save changes', exact: true }).click();
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await waitPdf();
    // Delay only the IPC acknowledgement, after the real utility/filesystem write.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
        }
      )._invokeHandlers;
      const original = handlers.get('loom:project:command')!;
      ipcMain.removeHandler('loom:project:command');
      ipcMain.handle('loom:project:command', async (event, command) => {
        const result = await original(event, command);
        if (command.type === 'sync') await new Promise((resolve) => setTimeout(resolve, 250));
        return result;
      });
    });
    const editor = page.locator('.cm-content');
    await editor.press('Control+End');
    await editor.press('Enter');
    for (let n = 0; n < 7; n++) {
      await editor.pressSequentially(`% Writing observation ${n}.\n`, { delay: 45 });
      await expect(page.locator('.conflict-panel')).not.toBeVisible();
      await expect(page.locator('.project-error')).not.toBeVisible();
    }
    await waitPdf();
    await expect
      .poll(() => readFile(join(root, 'main.tex'), 'utf8'))
      .toContain('% Writing observation 6.');
    await expect(page.locator('.conflict-panel')).not.toBeVisible();
    await expect(page.locator('.project-error')).not.toBeVisible();
    await page.screenshot({ path: 'artifacts/phase-3-quiet-typing.png' });
  });
  test('portable settings retain edits during polling, auto-build coalesces and narrow keyboard navigation works', async () => {
    await dimensions(1440, 960);
    await openExample();
    await page.locator('.build-status').click();
    const modal = page.getByRole('dialog', { name: 'PDF settings' });
    await modal.getByText('Advanced settings', { exact: true }).click();
    await modal.getByLabel('LaTeX engine', { exact: true }).selectOption('xelatex');
    await page.waitForTimeout(1500);
    await expect(modal.getByLabel('LaTeX engine', { exact: true })).toHaveValue('xelatex');
    await expect(modal.getByLabel('Update the PDF as I write')).toBeEnabled();
    await modal.getByLabel('Update the PDF as I write').check();
    await modal.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(modal.getByText('Changes saved', { exact: true })).toBeVisible();
    expect(JSON.parse(await readFile(join(root, 'loom.build.json'), 'utf8')).settings.engine).toBe(
      'xelatex',
    );
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await waitPdf();
    await page.locator('.cm-content').press('Control+End');
    await page.locator('.cm-content').pressSequentially('\n% automatic build boundary');
    await expect(page.locator('.build-status')).toHaveText('Changes not in PDF');
    await waitPdf();
    await dimensions(900, 700);
    await page.getByRole('button', { name: 'Show PDF preview', exact: true }).click();
    await expect(page.locator('.pdf-viewer')).toBeVisible();
    await expect(page.locator('.source-column')).not.toBeVisible();
    await page.getByRole('combobox', { name: 'PDF zoom' }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pdf-load-status')).toContainText('Select text');
    await page.screenshot({ path: 'artifacts/phase-3-small.png' });
    await page.getByRole('button', { name: 'Hide PDF panel', exact: true }).click();
    await expect(page.locator('.cm-content')).toBeVisible();
    await page.getByRole('button', { name: 'More workspace actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Scientific tools', exact: true }).click();
    await page.getByRole('button', { name: 'PDF settings', exact: true }).click();
    await expect(modal).toBeVisible();
  });
});

// Opt-in verification against an explicitly authorized local paper; never a committed fixture.
test('authorized local paper renders in the right PDF pane without source changes', async () => {
  test.skip(!process.env.LOOM_PDF_PAPER || process.env.LOOM_TEST_TEX !== '1');
  root = resolve(process.env.LOOM_PDF_PAPER!);
  const originalSource = await readFile(join(root, 'main.tex'));
  const originalSettings = await readFile(join(root, 'loom.build.json'));
  await dimensions(1440, 960);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, root);
  await page
    .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Open folder', exact: true })
    .click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.locator('.compile-source').click();
  try {
    await waitPdf();
  } catch (error) {
    const log = await page.evaluate(async () => {
      const project = await window.loom!.project({ type: 'current' });
      if (!project.ok || !project.value) return 'No project';
      const state = await window.loom!.latex({ type: 'status', projectId: project.value.id });
      return state.ok && state.value.kind === 'state' ? state.value.state.current?.log : state;
    });
    throw new Error(`${String(error)}\nBuild log: ${JSON.stringify(log)}`);
  }
  await expect(page.locator('.pdf-column')).toBeVisible();
  await page.screenshot({
    path: resolve('artifacts/pdf-user-paper-fixed.png'),
    animations: 'disabled',
  });
  expect(await readFile(join(root, 'main.tex'))).toEqual(originalSource);
  expect(await readFile(join(root, 'loom.build.json'))).toEqual(originalSettings);
});
