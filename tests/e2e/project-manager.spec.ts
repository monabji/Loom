import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { electronLaunchOptions } from './helpers/launch';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
let app: ElectronApplication;
let page: Page;
let dir: string;
async function launch(executablePath?: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  app = await _electron.launch({
    ...electronLaunchOptions(
      executablePath ? { ...process.env, LOOM_E2E_EXECUTABLE: executablePath } : process.env,
      [`--user-data-dir=${join(dir, 'data')}`],
    ),
    env,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeVisible();
  await expect(page.getByRole('main', { name: 'Your projects' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
}
async function size(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const [ow, oh] = w.getSize(),
        [cw, ch] = w.getContentSize();
      w.setMaximumSize(0, 0);
      w.setMinimumSize(width + ow - cw, height + oh - ch);
      w.setMaximumSize(width + ow - cw, height + oh - ch);
      w.setContentSize(width, height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
}
async function create(name: string) {
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    },
    join(dir, name),
  );
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toBeVisible();
}
async function library() {
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeVisible();
}
test.beforeEach(async ({}, testInfo) => {
  dir = await mkdtemp(
    join(
      testInfo.title.includes('project menu confirms Trash') ||
        testInfo.title.includes('closing the last project')
        ? homedir()
        : tmpdir(),
      '.loom-manager-',
    ),
  );
  await launch(testInfo.tags.includes('@upgrade') ? process.env.LOOM_E2E_UPGRADE_FROM : undefined);
  await size(1440, 900);
});
test.afterEach(async () => {
  await app
    ?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
    .catch(() => {});
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
test(
  'startup library creates and reopens projects with isolated text, preferences, draft and device appearance after full restart',
  { tag: '@upgrade' },
  async () => {
    await size(1440, 900);
    await expect(page.getByRole('heading', { name: 'A place for your next paper' })).toBeVisible();
    expect(
      await page.locator('.library-content').evaluate((e) => e.scrollHeight <= e.clientHeight),
    ).toBe(true);
    await page.screenshot({ path: 'artifacts/project-manager-empty.png' });
    await create('Paper A');
    let editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
    await editor.fill('A saved human revision.');
    let prompt = page.locator('.agent-prompt');
    await prompt.fill('Unsent Paper A draft');
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Appearance', exact: true });
    await appearance.getByRole('button', { name: /Iris/ }).click();
    await appearance.press('Escape');
    await page.getByRole('button', { name: 'Project file options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Project settings', exact: true }).click();
    await page.locator('.editor-preferences summary').click();
    await page.getByRole('slider', { name: 'Editor font size' }).fill('19');
    await page.keyboard.press('Escape');
    await library();
    expect(await readFile(join(dir, 'Paper A', 'main.tex'), 'utf8')).toBe(
      'A saved human revision.',
    );
    await create('Paper B');
    await expect(editor).not.toContainText('A saved human revision.');
    await expect(prompt).toHaveValue('');
    await editor.fill('B independent source.');
    await library();
    await page.screenshot({ path: 'artifacts/project-manager-list.png' });
    await page.getByRole('button', { name: 'Grid view', exact: true }).click();
    await page.screenshot({ path: 'artifacts/project-manager-grid.png' });
    await page.getByRole('textbox', { name: 'Search projects' }).fill('unmatched');
    await expect(page.getByRole('heading', { name: 'No matching projects' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear project search' }).click();
    await expect(page.getByRole('textbox', { name: 'Search projects' })).toBeFocused();
    const savedSources = await Promise.all(
      ['Paper A', 'Paper B'].map((name) => readFile(join(dir, name, 'main.tex'))),
    );
    await app.close();
    await launch();
    expect(
      await Promise.all(
        ['Paper A', 'Paper B'].map((name) => readFile(join(dir, name, 'main.tex'))),
      ),
    ).toEqual(savedSources);
    editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
    prompt = page.locator('.agent-prompt');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'iris');
    await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Open Paper A', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(editor).toContainText('A saved human revision.');
    await expect(prompt).toHaveValue('Unsent Paper A draft');
    await expect(editor).toHaveCSS('font-size', '19px');
    await library();
    await page.getByRole('button', { name: 'Open Paper B', exact: true }).click();
    await expect(editor).toContainText('B independent source.');
    await expect(prompt).toHaveValue('');
    await library();
    await size(720, 540);
    await page.getByRole('button', { name: 'Import project' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Import folder', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Import project' })).toBeFocused();
    await page.screenshot({ path: 'artifacts/project-manager-small.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  },
);
test('cancelled pickers and unavailable folders keep the manager and saved recovery state', async () => {
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeVisible();
  await create('Missing paper');
  await page.getByRole('textbox', { name: 'LaTeX source editor' }).fill('Recovery must remain.');
  await library();
  await rm(join(dir, 'Missing paper'), { recursive: true });
  await page.getByRole('button', { name: 'Refresh projects' }).click();
  await expect(
    page.getByText('Folder unavailable · Reconnect or restore its folder'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open Missing paper' }).click();
  await expect(page.getByRole('alert')).toContainText('recovery data has been retained');
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeVisible();
  await app.close();
  await launch();
  await expect(page.getByRole('button', { name: 'Open Missing paper' })).toBeVisible();
  await create('Available paper');
});

test('visible back navigation animates both ways, preserves the live workspace and respects reduced motion', async () => {
  await create('Navigation paper');
  const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await editor.fill('Keep this exact live editor and its text.');
  await page.locator('.agent-prompt').fill('Keep this unsent draft.');
  await page.evaluate(() => {
    const state = window as typeof window & {
      navigationFrames: Array<{
        types: string[];
        animation: string;
        duration: string;
        panelName: string;
      }>;
      retainedEditor: Element | null;
    };
    state.retainedEditor = document.querySelector('.cm-content');
    state.navigationFrames = [];
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (options) => {
      const transition = start(options);
      void transition.ready
        .then(() => {
          if (!transition.types.has('project-navigation')) return;
          const style = getComputedStyle(document.documentElement, '::view-transition-new(root)');
          state.navigationFrames.push({
            types: [...transition.types],
            animation: style.animationName,
            duration: style.animationDuration,
            panelName: getComputedStyle(document.querySelector('.source-column')!)
              .viewTransitionName,
          });
        })
        .catch(() => {});
      return transition;
    };
  });
  const back = page.getByRole('button', { name: 'Back to projects', exact: true });
  await expect(back).toBeVisible();
  await back.focus();
  await back.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeFocused();
  expect(await readFile(join(dir, 'Navigation paper', 'main.tex'), 'utf8')).toBe(
    'Keep this exact live editor and its text.',
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { navigationFrames: unknown[] }).navigationFrames.length,
      ),
    )
    .toBe(1);
  await page.screenshot({
    path: 'artifacts/project-navigation-library.png',
    animations: 'disabled',
  });
  const resume = page.getByRole('button', { name: 'Return to workspace', exact: true });
  await resume.focus();
  await resume.press('Enter');
  await expect(editor).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { navigationFrames: unknown[] }).navigationFrames.length,
      ),
    )
    .toBe(2);
  const frames = await page.evaluate(
    () =>
      (
        window as unknown as {
          navigationFrames: Array<{
            types: string[];
            animation: string;
            duration: string;
            panelName: string;
          }>;
        }
      ).navigationFrames,
  );
  expect(frames.map((f) => f.types)).toEqual([
    ['project-navigation', 'project-return'],
    ['project-navigation', 'project-open'],
  ]);
  expect(
    frames.every(
      (f) => f.animation === 'project-page-in' && f.duration === '0.28s' && f.panelName === 'none',
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.querySelector('.cm-content') ===
        (window as unknown as { retainedEditor: Element }).retainedEditor,
    ),
  ).toBe(true);
  await expect(editor).toContainText('Keep this exact live editor and its text.');
  await expect(page.locator('.agent-prompt')).toHaveValue('Keep this unsent draft.');
  await page.screenshot({
    path: 'artifacts/project-navigation-workspace.png',
    animations: 'disabled',
  });
  await size(720, 540);
  await expect(back).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await back.click();
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeFocused();
  await resume.click();
  await expect(editor).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as { navigationFrames: unknown[] }).navigationFrames.length,
    ),
  ).toBe(2);
  await page.screenshot({ path: 'artifacts/project-navigation-small.png', animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // A second navigation can interrupt an unfinished transition without losing the workspace.
  await back.click();
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(editor).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).not.toBeVisible();
});

test('project menu confirms Trash, retains failures, protects active paper and preserves siblings', async () => {
  await create('Trash paper');
  await library();
  await create('Sibling paper');
  await library();
  await page.getByRole('button', { name: 'Options for Sibling paper', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /This folder is open/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Options for Trash paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move project to Trash', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Move project to Trash?', exact: true });
  await expect(confirmation).toContainText('Trash paper');
  await expect(confirmation).toContainText(join(dir, 'Trash paper'));
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await access(join(dir, 'Trash paper', 'main.tex'));
  await expect(page.getByRole('button', { name: 'Open Trash paper', exact: true })).toBeVisible();
  await app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { originalTrash: typeof shell.trashItem };
    state.originalTrash = shell.trashItem;
    shell.trashItem = async () => {
      throw new Error('Injected native Trash failure');
    };
  });
  await page.getByRole('button', { name: 'Options for Trash paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move project to Trash', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('retained');
  await access(join(dir, 'Trash paper', 'main.tex'));
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await app.evaluate(({ shell }) => {
    shell.trashItem = (
      globalThis as typeof globalThis & { originalTrash: typeof shell.trashItem }
    ).originalTrash;
  });
  await page.getByRole('button', { name: 'Options for Trash paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move project to Trash', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Trash paper', exact: true })).toHaveCount(0);
  await expect(access(join(dir, 'Trash paper'))).rejects.toThrow();
  expect(await readFile(join(dir, 'Sibling paper', 'main.tex'), 'utf8')).toContain('documentclass');
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toBeVisible();
});

test('unavailable closed project offers list removal with cancellation', async () => {
  await create('Unavailable paper');
  await library();
  await create('Current paper');
  await library();
  await rm(join(dir, 'Unavailable paper'), { recursive: true });
  await page.getByRole('button', { name: 'Refresh projects', exact: true }).click();
  await page.getByRole('button', { name: 'Options for Unavailable paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove from list', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Remove project from list?', exact: true });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open Unavailable paper', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Options for Unavailable paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove from list', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Remove from list', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open Unavailable paper', exact: true }),
  ).toHaveCount(0);
});

test('native close releases the last project and rejects stale project identities', async () => {
  await create('Only project');
  await library();
  const result = await page.evaluate(async () => {
    const current = await window.loom!.project({ type: 'current' });
    if (!current.ok || !current.value) throw new Error('No current project');
    const blocked = await window.loom!.project({
      type: 'trash-project',
      projectId: current.value.id,
    });
    const stale = await window.loom!.project({ type: 'close-project', projectId: 'stale' });
    const closed = await window.loom!.project({
      type: 'close-project',
      projectId: current.value.id,
    });
    return { blocked, stale, closed };
  });
  expect(result.blocked.ok).toBe(false);
  expect(result.stale.ok).toBe(false);
  expect(result.closed).toMatchObject({ ok: true, value: null });
  await page.getByRole('button', { name: 'Refresh projects', exact: true }).click();
  await page.getByRole('button', { name: 'Options for Only project', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Move project to Trash', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await access(join(dir, 'Only project', 'main.tex'));
});

test('closing the last project saves writing, clears the workspace and permits deletion', async () => {
  await create('Last paper');
  await page.getByRole('textbox', { name: 'LaTeX source editor' }).fill('Saved before closing.');
  await page
    .getByRole('textbox', { name: 'Ask about your paper' })
    .fill('Retain this unsent draft.');
  await library();
  await page.getByRole('button', { name: 'Close project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to workspace', exact: true })).toHaveCount(
    0,
  );
  expect(await readFile(join(dir, 'Last paper', 'main.tex'), 'utf8')).toBe('Saved before closing.');
  await expect(page.getByRole('main', { name: 'Your projects' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.getByRole('button', { name: 'Options for Last paper', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Move project to Trash', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open Last paper', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
    'Saved before closing.',
  );
  await expect(page.getByRole('textbox', { name: 'Ask about your paper' })).toHaveValue(
    'Retain this unsent draft.',
  );
  await library();
  await page.getByRole('button', { name: 'Close project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Return to workspace', exact: true })).toHaveCount(
    0,
  );
  await size(720, 540);
  await page.getByRole('button', { name: 'Options for Last paper', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move project to Trash', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Move project to Trash?', exact: true });
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.screenshot({ path: 'artifacts/loom-project-trash-small.png', animations: 'disabled' });
  await confirmation.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open Last paper', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A place for your next paper' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A place for your next paper' })).toBeVisible();
});
