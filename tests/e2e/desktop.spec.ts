import { resumeFromLibrary } from './helpers/project-library';
import { electronLaunchOptions } from './helpers/launch';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import packageJson from '../../package.json';

let desktop: ElectronApplication;
let page: Page;
let userData: string;
let stoppedPid: number | undefined;

async function dimensions(width: number, height: number): Promise<void> {
  await desktop.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      // Keep a tiling Wayland compositor from resizing the fixture after a click/focus change.
      // Both constraints are test-owned; the product retains its normal resizable window.
      const [outerWidth, outerHeight] = window.getSize();
      const [contentWidth, contentHeight] = window.getContentSize();
      const width = size.width + outerWidth - contentWidth;
      const height = size.height + outerHeight - contentHeight;
      window.setMaximumSize(0, 0);
      window.setMinimumSize(width, height);
      window.setMaximumSize(width, height);
      window.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect
    .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual({ width, height });
}

async function readyPid(): Promise<number> {
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const result = await window.loom!.getStatus();
        return result.ok ? result.value.state : result.error.code;
      }),
    )
    .toBe('ready');
  const result = await page.evaluate(() => window.loom!.getStatus());
  if (!result.ok || !result.value.pid)
    throw new Error('The real utility process did not provide a PID.');
  return result.value.pid;
}

async function launchDesktop(executablePath?: string): Promise<void> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  desktop = await _electron.launch({
    chromiumSandbox: true,
    ...electronLaunchOptions(
      executablePath ? { ...env, LOOM_E2E_EXECUTABLE: executablePath } : env,
      [`--user-data-dir=${userData}`],
    ),
    env,
    timeout: 20_000,
  });
  page = await desktop.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await readyPid();
  if ((await page.locator('.library-project').count()) > 0) await resumeFromLibrary(page);
}
test.beforeEach(async ({}, testInfo) => {
  userData = await mkdtemp(join(tmpdir(), 'loom-desktop-e2e-'));
  await launchDesktop(
    testInfo.tags.includes('@upgrade') ? process.env.LOOM_E2E_UPGRADE_FROM : undefined,
  );
});

test.afterEach(async () => {
  if (stoppedPid) {
    try {
      process.kill(stoppedPid, 'SIGKILL');
    } catch {
      /* The timeout may have terminated it already. */
    }
    stoppedPid = undefined;
  }
  if (desktop) {
    if (test.info().status !== test.info().expectedStatus)
      await desktop
        .evaluate(({ BrowserWindow }) => {
          for (const win of BrowserWindow.getAllWindows()) win.destroy();
        })
        .catch(() => {});
    await desktop.close();
  }
  if (userData) await rm(userData, { recursive: true, force: true });
});

test('real isolated Electron boundary and a restartable utility process', async () => {
  expect(await desktop.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox'))).toBe(false);
  const isolation = await desktop.evaluate(({ BrowserWindow }) => {
    // Electron 45 retains this diagnostic method at runtime but omits its TS declaration.
    const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
      getLastWebPreferences(): {
        sandbox: boolean;
        contextIsolation: boolean;
        nodeIntegration: boolean;
      };
    };
    const preferences = contents.getLastWebPreferences();
    return {
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    };
  });
  expect(isolation).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect(
    await page.evaluate(() => ({
      api: Object.keys(window.loom!).sort(),
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    })),
  ).toEqual({
    api: [
      'agent',
      'chooseAttachments',
      'chooseFile',
      'chooseProject',
      'cloneGit',
      'completeClose',
      'exportPdf',
      'exportSource',
      'getStatus',
      'git',
      'latex',
      'onCloseRequest',
      'onServiceEvent',
      'openSetup',
      'openSource',
      'project',
      'research',
      'restartService',
    ],
    require: 'undefined',
    process: 'undefined',
  });

  const before = await readyPid();
  const serviceStatus = await page.evaluate(() => window.loom!.getStatus());
  expect(serviceStatus.ok && serviceStatus.value.version).toBe(packageJson.version);
  await page.getByRole('button', { name: 'Local service ready', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Electron desktop');
  await expect(page.getByRole('dialog')).toContainText(String(before));
  await page.getByRole('button', { name: 'Restart service', exact: true }).click();
  await expect.poll(() => readyPid()).not.toBe(before);
  await expect(page.getByRole('dialog').locator('.service-details dd').first()).toHaveText('ready');
  await page.keyboard.press('Escape');

  const originalUrl = page.url();
  await page.evaluate(() => {
    window.open('https://example.com');
  });
  expect(desktop.windows()).toHaveLength(1);
  await page.evaluate(() => {
    window.location.href = 'https://example.com';
  });
  // Electron cancels navigation before commit; CDP can retain a pending loader.
  // Inspect the live document URL and native WebContents instead of waiting for it.
  expect(await page.evaluate(() => location.href)).toBe(originalUrl);
  expect(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getURL(),
    ),
  ).toBe(originalUrl);
  expect(
    await page.evaluate(() => {
      const heading = document.querySelector('main h2');
      return { text: heading?.textContent, visible: Boolean(heading?.getClientRects().length) };
    }),
  ).toEqual({ text: 'A place for your next paper', visible: true });
  await readyPid();
});

async function showLayoutReference() {
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await page.getByRole('button', { name: 'Load read-only example', exact: true }).click();
}
test('a killed utility process reports failure and recovers without losing the workspace', async () => {
  await dimensions(1440, 900);
  const pid = await readyPid();
  await showLayoutReference();
  process.kill(pid, 'SIGKILL');
  await expect(
    page.getByRole('button', { name: 'Local service unavailable', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Read-only LaTeX example' })).toBeVisible();
  await page.getByRole('button', { name: 'Local service unavailable', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('stopped');
  await page.getByRole('button', { name: 'Restart service', exact: true }).click();
  const recoveredPid = await readyPid();
  expect(recoveredPid).not.toBe(pid);
  await expect(page.getByRole('dialog').locator('.service-details dd').first()).toHaveText('ready');
});

test('an unresponsive utility process times out and can be restarted', async () => {
  test.skip(process.platform !== 'linux', 'SIGSTOP failure injection is validated on Linux.');
  stoppedPid = await readyPid();
  await page.getByRole('button', { name: 'Local service ready', exact: true }).click();
  process.kill(stoppedPid, 'SIGSTOP');
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('did not respond', {
    timeout: 9_000,
  });
  await expect(page.getByRole('dialog').locator('.service-details dd').first()).toHaveText(
    'unavailable',
  );
  await page.getByRole('button', { name: 'Restart service', exact: true }).click();
  expect(await readyPid()).not.toBe(stoppedPid);
});

test('keyboard layout, saved preferences, focus modes, and reference screenshots', async () => {
  await dimensions(2048, 1096);
  await showLayoutReference();
  await expect(page.getByRole('complementary', { name: 'Project sidebar' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'PDF preview', exact: true })).toBeVisible();
  await showLayoutReference();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  const preview = page.getByRole('region', { name: 'PDF preview', exact: true });
  await expect(page.getByRole('button', { name: 'Hide PDF panel', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide PDF panel', exact: true }).click();
  await expect(preview).toHaveCount(0);
  const reopenPreview = page.getByRole('button', { name: 'Show PDF preview', exact: true });
  await expect(reopenPreview).toBeVisible();
  await expect(reopenPreview).toBeFocused();
  await reopenPreview.press('Enter');
  await expect(preview).toBeVisible();
  const hidePreview = page.getByRole('button', { name: 'Hide PDF preview', exact: true });
  await expect(hidePreview).toHaveAttribute('aria-pressed', 'true');
  await hidePreview.click();
  await expect(preview).toHaveCount(0);
  await page.reload();
  await resumeFromLibrary(page);
  await expect(preview).toHaveCount(0);
  await page.getByRole('button', { name: 'Show PDF preview', exact: true }).click();
  await expect(preview).toBeVisible();
  await showLayoutReference();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await mkdir(resolve('artifacts'), { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    path: resolve('artifacts/phase-1-electron-reference.png'),
    scale: 'css',
  });

  const divider = page.getByRole('separator', { name: 'Sidebar width' });
  const startingWidth = Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', String(startingWidth + 1));
  await page.reload();
  await resumeFromLibrary(page);
  await expect(divider).toHaveAttribute('aria-valuenow', String(startingWidth + 1));
  await divider.focus();
  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', String(startingWidth));
  await page.keyboard.press('Control+Alt+b');
  await expect(page.getByRole('complementary', { name: 'Project sidebar' })).toHaveCount(0);
  await page.reload();
  await resumeFromLibrary(page);
  await expect(page.getByRole('complementary', { name: 'Project sidebar' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore sidebar', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Project sidebar' })).toBeVisible();

  await page.getByRole('main', { name: 'Source workspace' }).focus();
  await page.keyboard.press('F6');
  await expect(page.getByRole('region', { name: 'PDF preview', exact: true })).toBeFocused();
  const keyboardFocus = await page
    .getByRole('region', { name: 'PDF preview', exact: true })
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        color: style.outlineColor,
        width: parseFloat(style.outlineWidth),
        style: style.outlineStyle,
      };
    });
  expect(keyboardFocus.style).toBe('none');
  expect(
    await preview
      .locator('.pdf-toolbar')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(232, 232, 232)');
  await page.keyboard.press('Shift+F6');
  await expect(page.getByRole('main', { name: 'Source workspace' })).toBeFocused();
  await page.keyboard.press('Control+Alt+2');
  await expect(page.getByRole('main', { name: 'Source workspace' })).toHaveCount(0);
  const skipLink = page.getByRole('link', { name: 'Skip to source' });
  await skipLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main', { name: 'Source workspace' })).toBeFocused();
  await page.keyboard.press('Control+Alt+3');
  await expect(page.getByRole('main', { name: 'Source workspace' })).toBeVisible();

  await dimensions(900, 700);
  await expect(page.getByRole('complementary', { name: 'Project sidebar' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'PDF preview', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Show PDF preview', exact: true }).click();
  await expect(preview).toBeVisible();
  await expect(page.getByRole('main', { name: 'Source workspace' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Hide PDF panel', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show PDF preview', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Show PDF preview', exact: true }).click();
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Source workspace' })).toBeVisible();
  await showLayoutReference();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.screenshot({
    animations: 'disabled',
    path: resolve('artifacts/phase-1-electron-small-source.png'),
    scale: 'css',
  });
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(page.getByRole('region', { name: 'PDF preview', exact: true })).toBeVisible();
  await expect(page.getByRole('main', { name: 'Source workspace' })).toHaveCount(0);
  await page.screenshot({
    animations: 'disabled',
    path: resolve('artifacts/phase-1-electron-small-pdf.png'),
    scale: 'css',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The keyboard skip link must also restore source when the narrow PDF view unmounts it.
  await skipLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main', { name: 'Source workspace' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Read-only LaTeX example' })).toBeVisible();
});

async function openSyntheticProject(): Promise<string> {
  await dimensions(1440, 960);
  const folder = join(userData, 'synthetic-project');
  await mkdir(folder);
  await writeFile(
    join(folder, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nOriginal text.\n\\end{document}\n',
  );
  await writeFile(join(folder, 'references.bib'), '@article{test, title={Synthetic}}\n');
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
  await page
    .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Open folder', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    'Original text.',
  );
  return folder;
}

test('opens and saves a project whose root path has spaces and non-ASCII characters', async () => {
  const folder = join(userData, '研究 project paper');
  await mkdir(folder);
  await writeFile(
    join(folder, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nOriginal text.\n\\end{document}\n',
  );
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);

  await page
    .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Open folder', exact: true })
    .click();
  const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await expect(editor).toContainText('Original text.');
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('% root path round trip');
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => readFile(join(folder, 'main.tex'), 'utf8'))
    .toContain('% root path round trip');

  await desktop.close();
  await launchDesktop();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    '% root path round trip',
  );
});

test('sidebar footer, folder navigation and row focus remain stable with many files', async () => {
  const folder = await openSyntheticProject();
  await page.keyboard.press('Control+Alt+3');
  await mkdir(join(folder, 'sections'));
  await Promise.all(
    Array.from({ length: 80 }, (_, i) =>
      writeFile(join(folder, 'sections', `part-${i}.tex`), `\\section{Part ${i}}\n`),
    ),
  );
  await page.evaluate(() => window.loom!.project({ type: 'refresh' }));
  const sidebar = page.getByRole('complementary', { name: 'Project sidebar' });
  const folderButton = sidebar.getByRole('button', { name: 'Folder sections', exact: true });
  await expect(folderButton).toBeVisible();
  await folderButton.click();
  await expect(folderButton).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => window.loom!.project({ type: 'refresh' }));
  await expect(folderButton).toHaveAttribute('aria-expanded', 'false');
  await folderButton.click();
  const row = sidebar.getByRole('button', { name: 'sections/part-0.tex', exact: true });
  await row.focus();
  await writeFile(join(folder, 'focus-marker.tex'), 'external addition');
  await expect(
    sidebar.getByRole('button', { name: 'focus-marker.tex', exact: true }),
  ).toBeVisible();
  await expect(row).toBeFocused();
  const footerGap = await sidebar.evaluate(
    (element) =>
      element.getBoundingClientRect().bottom -
      element.querySelector('.sidebar-footer')!.getBoundingClientRect().bottom,
  );
  expect(footerGap).toBeLessThanOrEqual(1);
  expect(
    await page
      .locator('.project-browser')
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await dimensions(1280, 720);
  expect(
    await sidebar.evaluate(
      (element) =>
        element.querySelector('.sidebar-footer')!.getBoundingClientRect().bottom <= innerHeight,
    ),
  ).toBe(true);
});

test('Prism navigation, native folder creation, assets and narrow dialog stay usable', async () => {
  const folder = await openSyntheticProject();
  await page.keyboard.press('Control+Alt+3');
  await mkdir(join(folder, 'sections'));
  await mkdir(join(folder, 'assets'));
  await writeFile(
    join(folder, 'sections', 'background.tex'),
    '\\section{Background}\nSynthetic background.\n',
  );
  await writeFile(
    join(folder, 'sections', 'methods.tex'),
    '\\section{Methods}\nReproducible methods.\n',
  );
  await writeFile(join(folder, 'assets', 'figure.png'), Buffer.from([0, 255, 4]));
  await writeFile(
    join(folder, 'main.tex'),
    '\\documentclass[11pt]{article}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{graphicx}\n\n\\title{A reproducible manuscript}\n\\author{Loom Example}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\\section{Introduction}\nOriginal text.\n\n\\input{sections/background}\n\\input{sections/methods}\n\\bibliography{references}\n\\end{document}\n',
  );
  await expect(page.getByRole('button', { name: 'Folder sections', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    'A reproducible manuscript',
  );
  const syntaxContrast = await page.locator('.cm-content').evaluate((editor) => {
    const luminance = (color: string) => {
      const channels = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((n) => {
          const c = n / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const background = luminance(
      getComputedStyle(document.querySelector('.source-column')!).backgroundColor,
    );
    const colors = new Set(
      [...editor.querySelectorAll('.cm-line span')]
        .filter((span) => span.textContent?.trim())
        .map((span) => getComputedStyle(span).color),
    );
    return {
      colors: colors.size,
      minimum: Math.min(
        ...[...colors].map((color) => (luminance(color) + 0.05) / (background + 0.05)),
      ),
    };
  });
  expect(syntaxContrast.colors).toBeGreaterThanOrEqual(2);
  expect(syntaxContrast.minimum).toBeGreaterThanOrEqual(4.5);
  await desktop.evaluate(
    ({ dialog }, path) => {
      dialog.showSaveDialog = async (...args: unknown[]) => {
        (globalThis as { fileDialogOptions?: unknown }).fileDialogOptions = args.at(-1);
        return { canceled: false, filePath: path };
      };
    },
    join(folder, 'sections', 'picked.tex'),
  );
  await page.getByRole('button', { name: 'New file in sections', exact: true }).click();
  await expect
    .poll(() => readFile(join(folder, 'sections', 'picked.tex'), 'utf8').catch(() => null))
    .toBe('');
  expect(
    await desktop.evaluate(() => (globalThis as { fileDialogOptions?: unknown }).fileDialogOptions),
  ).toMatchObject({ defaultPath: join(folder, 'sections', 'untitled.tex') });
  const sidebar = page.getByRole('complementary', { name: 'Project sidebar' });
  await sidebar.getByRole('button', { name: 'main.tex', exact: true }).click();
  await dimensions(1600, 1000);
  await page.screenshot({
    path: resolve('artifacts/phase-2-ux-workspace.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Actions for main.tex', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Actions for main.tex' });
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    }),
  ).toBe(true);
  await page.screenshot({
    path: resolve('artifacts/phase-2-ux-file-menu.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await sidebar.getByRole('button', { name: 'assets/figure.png', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project asset' })).toBeVisible();
  await sidebar.getByRole('button', { name: 'main.tex', exact: true }).click();
  await sidebar.getByRole('button', { name: 'Chats', exact: true }).click();
  await expect(sidebar).toContainText('No conversations yet');
  await sidebar.getByRole('button', { name: 'Files', exact: true }).click();
  await dimensions(900, 700);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Project files', exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve('artifacts/phase-2-ux-small.png'),
    animations: 'disabled',
  });
  await dimensions(720, 540);
  const navigation = page.getByRole('dialog', { name: 'Project files', exact: true });
  expect(
    await navigation.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return r.bottom <= innerHeight && r.top >= 0 && r.width <= innerWidth;
    }),
  ).toBe(true);
  await navigation.getByRole('button', { name: 'sections/methods.tex', exact: true }).click();
  await expect(navigation).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    'Reproducible methods',
  );
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await desktop.evaluate(
    ({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    },
    join(userData, 'outside-compact.tex'),
  );
  await navigation.getByRole('button', { name: 'New file', exact: true }).click();
  await expect(navigation.getByRole('alert')).toContainText('inside the open project folder');
  await desktop.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  });
  await navigation.getByRole('button', { name: 'New file', exact: true }).click();
  await expect(navigation).toBeVisible();
  const compactFile = join(folder, 'sections', 'compact.tex');
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, compactFile);
  await navigation.getByRole('button', { name: 'New file', exact: true }).click();
  await expect(navigation).not.toBeVisible();
  const compactEditor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await expect(compactEditor).toBeFocused();
  await page.keyboard.type('% ready to edit');
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFile(compactFile, 'utf8')).toBe('% ready to edit');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('file action menus support keyboard, inline errors, search and reduced motion', async () => {
  const folder = await openSyntheticProject();
  await page.keyboard.press('Control+Alt+3');
  const trigger = page.getByRole('button', { name: 'Actions for main.tex', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Rename / move', exact: true })).toBeFocused();
  await writeFile(join(folder, 'added-during-menu.tex'), 'external addition');
  await expect(
    page.getByRole('button', { name: 'added-during-menu.tex', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Rename / move', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Rename / move', exact: true }).click();
  const path = page.getByRole('textbox', { name: 'Project-relative path' });
  await expect(path).toBeFocused();
  await path.fill('../outside.tex');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(path).toHaveValue('../outside.tex');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Search project', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search project text' });
  await expect(search).toBeFocused();
  await search.fill('absent-word-924');
  await search.press('Enter');
  await expect(page.getByRole('region', { name: 'Project search results' })).toContainText(
    '0 results',
  );
  await page.getByRole('button', { name: 'Clear project search' }).click();
  await expect(search).toBeFocused();
  await expect(page.getByRole('button', { name: 'main.tex', exact: true }).first()).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await trigger.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    '0s',
  );
});

test('New file uses the native save picker and opens the created file', async () => {
  const folder = await openSyntheticProject();
  await page.keyboard.press('Control+Alt+3');
  const path = join(folder, '章节', 'new.tex');
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, path);
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await expect.poll(() => readFile(path, 'utf8').catch(() => null)).toBe('');
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toBeVisible();
  await expect(page.locator('.source-tab')).toContainText('new.tex');
});
test('native file picker cancellation and rejected destinations preserve the active source', async () => {
  const folder = await openSyntheticProject();
  await page.keyboard.press('Control+Alt+3');
  await desktop.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async (...args: unknown[]) => {
      (globalThis as { fileDialogOptions?: unknown }).fileDialogOptions = args.at(-1);
      return { canceled: true, filePath: '' };
    };
  });
  const create = page.getByRole('button', { name: 'New file', exact: true });
  await create.click();
  await expect(create).toBeEnabled();
  expect(
    await desktop.evaluate(() => (globalThis as { fileDialogOptions?: unknown }).fileDialogOptions),
  ).toMatchObject({ title: 'Create new file', defaultPath: join(folder, 'untitled.tex') });
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    'Original text.',
  );
  await desktop.evaluate(
    ({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    },
    join(userData, 'outside.tex'),
  );
  await create.click();
  await expect(page.getByRole('alert')).toContainText('inside the open project folder');
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    'Original text.',
  );
  await expect
    .poll(() => readFile(join(userData, 'outside.tex'), 'utf8').catch(() => null))
    .toBe(null);
});

test('real project editing, external reconciliation, restart, IndexedDB, tabs and small window', async () => {
  const folder = await openSyntheticProject();
  const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('% Human addition');
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFile(join(folder, 'main.tex'), 'utf8')).toContain('% Human addition');
  await expect(page.locator('.readonly-label')).toHaveText('Saved to disk');
  await page.keyboard.press('Control+Alt+3');
  await expect(page.getByRole('button', { name: 'Hide PDF preview', exact: true })).toBeVisible();
  const liveEditor = await page.locator('.cm-editor').elementHandle();
  await page.getByRole('button', { name: 'Hide PDF preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'PDF preview', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show PDF preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'PDF preview', exact: true })).toBeVisible();
  expect(await liveEditor!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(editor).toContainText('% Human addition');
  await page.screenshot({ path: 'artifacts/phase-2-preview-toggle.png', animations: 'disabled' });
  await dimensions(1440, 960);
  await page.keyboard.press('Control+Alt+3');
  await page.getByRole('button', { name: 'references.bib', exact: true }).click();
  await expect(editor).toContainText('@article');
  await page.getByRole('button', { name: 'main.tex', exact: true }).last().click();
  expect(
    await page
      .locator('.source-tab')
      .last()
      .evaluate((node) => getComputedStyle(node).outlineStyle),
  ).toBe('none');
  await expect(editor).toContainText('% Human addition');
  const text = await readFile(join(folder, 'main.tex'), 'utf8');
  await writeFile(join(folder, 'main.tex'), text.replace('Original text.', 'External text.'));
  await expect(editor).toContainText('External text.');
  await expect(editor).toContainText('% Human addition');
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).toContainText('External text.');
  await expect(editor).not.toContainText('% Human addition');
  await editor.focus();
  await page.keyboard.press('Control+Shift+z');
  await expect(editor).toContainText('% Human addition');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.readonly-label')).toHaveText('Saved to disk');
  await page.reload();
  await resumeFromLibrary(page);
  await expect(editor).toContainText('% Human addition');
  await expect(editor).toContainText('External text.');
  await page.evaluate(() => window.loom!.restartService());
  await readyPid();
  await expect(page.locator('.readonly-label')).toHaveText('Saved to disk');
  await expect(editor).toContainText('% Human addition');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' after restart');
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFile(join(folder, 'main.tex'), 'utf8')).toContain('after restart');
  await mkdir(resolve('artifacts'), { recursive: true });
  await dimensions(2048, 1096);
  await page.screenshot({
    animations: 'disabled',
    path: resolve('artifacts/phase-2-electron-reference.png'),
  });
  await dimensions(900, 700);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('references.bib');
  await page.screenshot({
    animations: 'disabled',
    path: resolve('artifacts/phase-2-electron-small.png'),
  });
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('unsent local edits and external overlaps remain reviewable', async () => {
  const folder = await openSyntheticProject();
  const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Human replacement');
  await writeFile(join(folder, 'main.tex'), 'External replacement');
  await expect(page.getByRole('region', { name: 'File conflict' })).toBeVisible();
  await expect(editor).toContainText('Human replacement');
  expect(await readFile(join(folder, 'main.tex'), 'utf8')).toBe('External replacement');
  await page.reload();
  await resumeFromLibrary(page);
  await expect(page.getByRole('region', { name: 'File conflict' })).toBeVisible();
  await expect(editor).toContainText('Human replacement');
  await page.getByRole('button', { name: 'Keep local text' }).click();
  await expect.poll(() => readFile(join(folder, 'main.tex'), 'utf8')).toBe('Human replacement');
});

test('file operations, root choice, search locations, find/replace and caret restoration', async () => {
  const folder = await openSyntheticProject(),
    editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await editor.focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await dimensions(1440, 960);
  await page.keyboard.press('Control+Alt+3');
  await page.getByRole('button', { name: 'references.bib', exact: true }).click();
  await page.getByRole('button', { name: 'main.tex', exact: true }).last().click();
  await editor.focus();
  expect(await page.evaluate(() => getSelection()?.anchorOffset)).toBe(3);
  await page.getByRole('button', { name: 'Find / replace', exact: true }).click();
  const findPanel = page.locator('.cm-search');
  const findField = page.getByRole('textbox', { name: 'Find', exact: true });
  await expect(findField).toBeFocused();
  await findField.fill('original');
  await findField.press('ArrowRight');
  await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
  await page.getByRole('checkbox', { name: 'match case', exact: true }).check();
  await expect(page.locator('.cm-searchMatch')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'match case', exact: true }).uncheck();
  await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
  await findField.fill('[Oo]riginal');
  await findField.press('ArrowRight');
  await page.getByRole('checkbox', { name: 'regexp', exact: true }).check();
  await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
  await page.getByRole('checkbox', { name: 'regexp', exact: true }).uncheck();
  await findField.fill('Orig');
  await findField.press('ArrowRight');
  await page.getByRole('checkbox', { name: 'by word', exact: true }).check();
  await expect(page.locator('.cm-searchMatch')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'by word', exact: true }).uncheck();
  await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
  await findField.fill('Original');
  await findField.press('ArrowRight');
  expect(
    await findPanel
      .locator('.cm-button')
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundImage),
  ).toBe('none');
  expect(await findField.evaluate((node) => getComputedStyle(node).borderRadius)).toBe('12px');
  await page.screenshot({ path: 'artifacts/phase-2-find-panel.png', animations: 'disabled' });
  await dimensions(720, 540);
  await page.screenshot({ path: 'artifacts/phase-2-find-panel-small.png', animations: 'disabled' });
  expect(
    await findPanel.evaluate((panel) => {
      const bounds = panel.parentElement!.getBoundingClientRect();
      return [...panel.querySelectorAll('input,button,label')].every((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.left >= bounds.left &&
          rect.right <= bounds.right &&
          rect.top >= bounds.top &&
          rect.bottom <= bounds.bottom &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
    }),
  ).toBe(true);
  await findField.focus();
  await findField.press('Escape');
  await expect(findPanel).toHaveCount(0);
  await expect(editor).toBeFocused();
  await dimensions(1440, 960);
  await page.getByRole('button', { name: 'Find / replace', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find', exact: true }).fill('Original');
  await page.getByRole('textbox', { name: 'Replace', exact: true }).fill('Updated');
  await page.getByRole('button', { name: 'replace all', exact: true }).click();
  await expect(editor).toContainText('Updated text.');
  await page.getByRole('button', { name: 'close', exact: true }).click();
  await editor.focus();
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFile(join(folder, 'main.tex'), 'utf8')).toContain('Updated text.');
  await page.getByRole('button', { name: 'Search project', exact: true }).click();
  const query = page.getByRole('textbox', { name: 'Search project text' });
  await query.fill('Updated text.');
  const hit = page.getByRole('button', { name: /main.tex:4/ });
  await expect(hit).toBeVisible();
  await hit.click();
  await page.getByRole('button', { name: 'Clear project search' }).click();
  await expect(query).toBeFocused();
  await desktop.evaluate(
    ({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    },
    join(folder, '章节/结果.tex'),
  );
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Project sidebar' })
    .getByRole('button', { name: '章节/结果.tex', exact: true })
    .click();
  await page.getByRole('button', { name: 'Actions for 章节/结果.tex', exact: true }).click();
  await page.getByRole('menuitem', { name: /Use 章节\/结果.tex as root/ }).click();
  await page.getByRole('button', { name: 'Actions for 章节/结果.tex', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename / move', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project-relative path' }).fill('sections/results.tex');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'sections/results.tex', exact: true }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Project file options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete selected file', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete file', exact: true });
  await expect(deletion).toContainText('sections/results.tex');
  await expect(deletion.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await readFile(join(folder, 'sections/results.tex'), 'utf8')).toBe('');
  await page.getByRole('button', { name: 'Project file options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete selected file', exact: true }).click();
  await deletion.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Project file options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Deleted files (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Restore sections/results.tex' }).click();
  await expect
    .poll(async () => {
      try {
        return await readFile(join(folder, 'sections/results.tex'), 'utf8');
      } catch {
        return null;
      }
    })
    .toBe('');
});

test('fuzzy project search highlights results and source without changing text or precise find', async () => {
  const folder = await openSyntheticProject();
  const source =
    '\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n🧪 İ Introduction to scientific writing.\n\\end{document}\n';
  await writeFile(join(folder, 'main.tex'), source);
  const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await expect(editor).toContainText('scientific writing');
  await page.keyboard.press('Control+Alt+3');
  await page.getByRole('button', { name: 'Search project', exact: true }).click();
  const query = page.getByRole('textbox', { name: 'Search project text' });
  const results = page.getByRole('region', { name: 'Project search results' });
  await query.fill('intrduction');
  await query.press('Enter');
  await expect(results.getByRole('button')).toHaveCount(2);
  await expect(results.locator('mark')).toHaveText(['Introduction', 'Introduction']);
  await expect(results).toContainText('Approximate text match');
  const hit = results.getByRole('button', { name: /main.tex:4/ });
  await hit.focus();
  await hit.press('Enter');
  await expect(editor).toBeFocused();
  await expect(page.locator('.cm-projectSearchMatch')).toHaveCount(2);
  await expect(page.locator('.cm-projectSearchMatch.is-current')).toHaveText('Introduction');
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('Introduction');
  expect(await readFile(join(folder, 'main.tex'), 'utf8')).toBe(source);
  const contrast = await page.locator('.cm-projectSearchMatch.is-current').evaluate((node) => {
    const style = getComputedStyle(node);
    const luminance = (color: string) => {
      const channels = color
        .match(/\d+/g)!
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const s = value / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const a = luminance(style.color),
      b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: 'artifacts/phase-2-fuzzy-search.png', animations: 'disabled' });
  // Highlight-only changes must not own undo or replace/remount the live editor.
  await editor.press('ArrowRight');
  await editor.press('End');
  await page.keyboard.type(' Search edit.');
  await expect(editor).toContainText('Search edit.');
  await editor.press('Control+z');
  await expect(editor).not.toContainText('Search edit.');
  await expect(page.locator('.cm-projectSearchMatch')).toHaveCount(2);
  await expect.poll(() => readFile(join(folder, 'main.tex'), 'utf8')).toBe(source);
  // CodeMirror takes precedence while Ctrl+F is open; replacement never uses approximate matches.
  await editor.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Find', exact: true });
  await find.fill('intrduction');
  await find.press('ArrowRight');
  await expect(page.locator('.cm-projectSearchMatch')).toHaveCount(0);
  await expect(page.locator('.cm-searchMatch')).toHaveCount(0);
  await find.fill('Introduction');
  await find.press('ArrowRight');
  await expect(page.locator('.cm-searchMatch')).toHaveCount(2);
  await page.getByRole('button', { name: 'close', exact: true }).click();
  await expect(page.locator('.cm-projectSearchMatch')).toHaveCount(2);
  // Shared search survives navigating through the compact dialog.
  await dimensions(900, 700);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Project files', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Search project text' })).toHaveValue(
    'intrduction',
  );
  await dialog.getByRole('button', { name: /main.tex:3/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(editor).toBeFocused();
  await expect(page.locator('.cm-projectSearchMatch.is-current')).toHaveText('Introduction');
  await page.screenshot({
    path: 'artifacts/phase-2-fuzzy-search-small.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await dialog.getByRole('button', { name: 'Clear project search' }).click();
  await expect(page.locator('.cm-projectSearchMatch')).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Search project text' })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await readFile(join(folder, 'main.tex'), 'utf8')).toBe(source);
});

test('fuzzy filename navigation, live search refresh, IME and clearing remain usable', async () => {
  const folder = await openSyntheticProject();
  await page.keyboard.press('Control+Alt+3');
  await page.getByRole('button', { name: 'Search project', exact: true }).click();
  const query = page.getByRole('textbox', { name: 'Search project text' });
  const results = page.getByRole('region', { name: 'Project search results' });
  await query.fill('mtex');
  const file = results.getByRole('button', { name: /main.tex/ }).first();
  await expect(file.locator('strong mark')).toHaveText(['m', 't', 'e', 'x']);
  await file.click();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toBeFocused();
  await query.fill('newobservtion');
  await expect(results).toContainText('Try another word or filename.');
  await writeFile(join(folder, 'observations.tex'), 'A newobservation from disk.');
  await expect(results.getByRole('button', { name: /observations.tex:1/ })).toBeVisible();
  await expect(results.locator('mark')).toHaveText(['newobservation']);
  await query.fill('Original');
  await query.press('Enter');
  await query.fill('nothingmatches924');
  await expect(results).toContainText('Try another word or filename.');
  await expect(results.getByRole('button')).toHaveCount(0);
  // Composition updates neither submit nor decorate an incomplete query.
  await query.dispatchEvent('compositionstart');
  await query.fill('Introduction');
  await query.press('Enter');
  await expect(page.locator('.cm-projectSearchMatch')).toHaveCount(0);
  await expect(results.getByRole('button')).toHaveCount(0);
  await query.dispatchEvent('compositionend');
  await expect(results.locator('mark')).toHaveText(['Introduction']);
  await page.getByRole('button', { name: 'Clear project search' }).click();
  await expect(query).toBeFocused();
  await expect(query).toHaveValue('');
  await expect(page.locator('.cm-projectSearchMatch')).toHaveCount(0);
});

test(
  'IndexedDB-only edits survive renderer crash with disk divergence',
  { tag: '@upgrade' },
  async () => {
    const folder = await openSyntheticProject();
    const original = await readFile(join(folder, 'main.tex'), 'utf8');
    const pid = await readyPid();
    process.kill(pid, 'SIGSTOP');
    stoppedPid = pid;
    const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
    await editor.focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Recovered human text');
    // A readonly transaction queues after y-indexeddb writes and proves they committed.
    await page.evaluate(async () => {
      for (const info of await indexedDB.databases()) {
        if (!info.name?.startsWith('loom:')) continue;
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(info.name!);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('updates', 'readonly');
            tx.objectStore('updates').getAll();
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
          };
        });
      }
    });
    expect(await readFile(join(folder, 'main.tex'), 'utf8')).toBe(original);
    await writeFile(join(folder, 'main.tex'), 'External while stopped');
    process.kill(pid, 'SIGKILL');
    stoppedPid = undefined;
    const recoveredWindow = desktop.waitForEvent('window');
    await desktop.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      process.kill(contents.getOSProcessId(), 'SIGKILL');
    });
    page = await recoveredWindow;
    await page.waitForLoadState('domcontentloaded');
    await resumeFromLibrary(page);
    await expect(page.getByRole('region', { name: 'File conflict' })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
      'Recovered human text',
    );
    expect(await readFile(join(folder, 'main.tex'), 'utf8')).toBe('External while stopped');
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
    );
    await desktop.close();
    await launchDesktop();
    await expect(page.getByRole('region', { name: 'File conflict' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
      'Recovered human text',
    );
    expect(await readFile(join(folder, 'main.tex'), 'utf8')).toBe('External while stopped');
    await page.getByRole('button', { name: 'Keep local text' }).click();
    await expect
      .poll(() => readFile(join(folder, 'main.tex'), 'utf8'))
      .toBe('Recovered human text');
  },
);

test('native project creation and ZIP import preserve ordinary source and assets', async () => {
  const created = join(userData, 'created-project');
  await desktop.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, created);
  await page
    .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(await readFile(join(created, 'main.tex'), 'utf8')).toContain('\\documentclass{article}');
  const { zipSync, strToU8 } = await import('fflate');
  const archive = join(userData, 'source.zip'),
    destination = join(userData, 'imported-project');
  await writeFile(
    archive,
    zipSync({
      'paper.tex': strToU8('\\documentclass{article}\n\\begin{document}Imported\\end{document}'),
      'figures/pixel.bin': new Uint8Array([0, 255, 4]),
    }),
  );
  await desktop.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.archive] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.destination });
    },
    { archive, destination },
  );
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await page.getByRole('button', { name: 'Import ZIP', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    'Imported',
  );
  expect(await readFile(join(destination, 'figures/pixel.bin'))).toEqual(Buffer.from([0, 255, 4]));
});

test('native close flushes pending text and working state before a full app reopen', async () => {
  const folder = await openSyntheticProject();
  const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('% close must flush');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await desktop.close();
  expect(await readFile(join(folder, 'main.tex'), 'utf8')).toContain('% close must flush');
  await launchDesktop();
  const restored = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await expect(restored).toContainText('% close must flush');
  await restored.focus();
  expect(await page.evaluate(() => getSelection()?.anchorOffset)).toBe(3);
});

test('failed working-state persistence keeps the native window open', async () => {
  await openSyntheticProject();
  const snapshot = await page.evaluate(() => window.loom!.project({ type: 'current' }));
  if (!snapshot.ok) throw new Error('Project did not load.');
  // Inject only the persistence result at main IPC; this is a simulated failure, not disk exhaustion.
  await desktop.evaluate(({ ipcMain }, snapshot) => {
    ipcMain.removeHandler('loom:project:command');
    ipcMain.handle('loom:project:command', (_event, command) =>
      command.type === 'preferences'
        ? {
            ok: false,
            error: {
              code: 'PROJECT_ERROR',
              message: 'Simulated preferences write failure',
              retryable: true,
            },
          }
        : snapshot,
    );
  }, snapshot);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(page.getByRole('alert')).toContainText('Simulated preferences write failure');
  expect(desktop.windows()).toHaveLength(1);
  await desktop.evaluate(({ ipcMain }, snapshot) => {
    ipcMain.removeHandler('loom:project:command');
    ipcMain.handle('loom:project:command', () => snapshot);
  }, snapshot);
});

test('beta workspace actions stay compact, discoverable and keyboard accessible', async () => {
  await openSyntheticProject();
  await expect(page.getByText('Local workspace', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0);
  const toolbar = page.locator('.source-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Open Git repository' })).toBeVisible();
  const tab = toolbar.getByRole('button', { name: 'main.tex', exact: true });
  expect(await tab.evaluate((node) => getComputedStyle(node).borderTopColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
  const source = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await source.fill('Preserved while opening workspace actions.');
  for (const width of [1440, 720]) {
    await dimensions(width, width === 720 ? 540 : 900);
    const overflow = page.getByRole('button', { name: 'More workspace actions' });
    await overflow.focus();
    await overflow.press('ArrowDown');
    const scientificTools = page.getByRole('menuitem', { name: 'Scientific tools' });
    await expect(scientificTools).toBeFocused();
    await dimensions(width - 10, width === 720 ? 540 : 900);
    await expect(scientificTools).toBeFocused();
    await scientificTools.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Workspace tools' });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: `artifacts/beta-tools-${width}.png`, animations: 'disabled' });
    await dialog.press('Escape');
    await expect(overflow).toBeFocused();
    await expect(source).toContainText('Preserved while opening workspace actions.');
    expect(await toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({
      path: `artifacts/beta-workspace-${width}.png`,
      animations: 'disabled',
    });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'References', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'References', exact: true })).toBeVisible();
});

test('appearance themes apply immediately, persist and keep the small workspace usable', async () => {
  await openSyntheticProject();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  const schemes = dialog.getByRole('group', { name: 'Color scheme' });
  const themes = dialog.getByRole('group', { name: 'Themes', exact: true });
  await schemes.getByRole('button', { name: 'Light', exact: true }).click();
  await themes.getByRole('button', { name: /Ocean/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'light');
  expect(
    await page.locator('.source-column').evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(252, 252, 253)');
  await dialog.getByRole('combobox', { name: 'Diff colors' }).selectOption('blue-amber');
  await dialog.getByRole('combobox', { name: 'Chat width' }).selectOption('comfortable');
  const contrast = dialog.getByRole('slider', { name: 'Interface contrast' });
  await contrast.focus();
  await contrast.press('ArrowRight');
  await expect(contrast).toHaveValue('101');
  await page.screenshot({ path: 'artifacts/appearance-light.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await resumeFromLibrary(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ocean');
  await expect(page.locator('html')).toHaveAttribute('data-diff', 'blue-amber');
  await dimensions(720, 540);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(contrast).toHaveValue('101');
  await schemes.getByRole('button', { name: 'Dark', exact: true }).click();
  await themes.getByRole('button', { name: /Iris/ }).click();
  await dialog.getByRole('combobox', { name: 'Chat width' }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('combobox', { name: 'Chat width' })).toBeInViewport();
  await page.screenshot({ path: 'artifacts/appearance-small.png', animations: 'disabled' });
  await schemes.getByRole('button', { name: 'System', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'dark');
  await dialog.getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await dialog.press('Escape');
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    'Original text.',
  );
});
