import { resumeFromLibrary } from './helpers/project-library';
import { electronLaunchOptions } from './helpers/launch';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
let app: ElectronApplication, page: Page, dir: string, root: string;
const source =
  '\\documentclass{article}\n\\begin{document}\nA synthetic claim.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n';
const bib =
  '@article{Synthetic2024, title={Synthetic reference}, author={Researcher, Ada}, year={2024}, journal={Synthetic Journal}, doi={10.0000/synthetic}, abstract={A synthetic abstract for inspection only.}, unknown={preserve {this} value}}\n';
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loom-research-e2e-'));
  root = join(dir, 'paper');
  await mkdir(root);
  await writeFile(join(root, 'main.tex'), source);
  await writeFile(join(root, 'refs.bib'), bib);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  app = await _electron.launch({
    ...electronLaunchOptions(process.env, [`--user-data-dir=${join(dir, 'data')}`]),
    env,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const [ow, oh] = w.getSize(),
      [cw, ch] = w.getContentSize();
    w.setMaximumSize(0, 0);
    w.setMinimumSize(1440 + ow - cw, 900 + oh - ch);
    w.setMaximumSize(1440 + ow - cw, 900 + oh - ch);
    w.setContentSize(1440, 900);
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = await window.loom!.getStatus();
        return s.ok && s.value.state;
      }),
    )
    .toBe('ready');
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
});
test.afterEach(async () => {
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      })
      .catch(() => {});
    await app.close();
  }
  await rm(dir, { recursive: true, force: true });
});
async function references(count = 1) {
  await page.getByRole('button', { name: 'References', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'References', exact: true })).toBeVisible();
  await expect(page.locator('.reference-result')).toHaveCount(count);
}
async function cursor() {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
}
test('local reference preview, keyboard citation and repeated import preserve bibliography', async () => {
  await cursor();
  await references();
  await page.locator('.reference-result').focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Abstract only · full text not inspected', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Citation key', { exact: true })).toHaveValue('Synthetic2024');
  await page.getByText('BibTeX preview', { exact: true }).click();
  await expect(page.locator('.reference-detail pre')).toContainText(
    'unknown={preserve {this} value}',
  );
  await page.getByRole('button', { name: 'Insert citation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'References', exact: true })).not.toBeVisible();
  await expect
    .poll(() => readFile(join(root, 'main.tex'), 'utf8'))
    .toContain('A synthetic claim.\\cite{Synthetic2024}');
  expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(bib);
  await references();
  await page.locator('.reference-result').click();
  await page.getByRole('button', { name: 'Insert citation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'References', exact: true })).not.toBeVisible();
  expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(bib);
  await page.reload();
  await resumeFromLibrary(page);
  await expect(page.locator('.cm-content')).toContainText('\\cite{Synthetic2024}');
});
test('search clear, empty state, contextual agent evidence and narrow modal stay usable', async () => {
  await cursor();
  await references();
  await page.getByLabel('Search references', { exact: true }).fill('no matches');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(
    page.getByText('No matching records. Try a different query.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear reference search', exact: true }).click();
  await expect(page.getByLabel('Search references', { exact: true })).toBeFocused();
  await expect(page.locator('.reference-result')).toHaveCount(1);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const [ow, oh] = w.getSize(),
      [cw, ch] = w.getContentSize();
    w.setMaximumSize(0, 0);
    w.setMinimumSize(720 + ow - cw, 540 + oh - ch);
    w.setMaximumSize(720 + ow - cw, 540 + oh - ch);
    w.setContentSize(720, 540);
  });
  await page.locator('.reference-result').click();
  await page
    .getByRole('button', { name: 'Discuss with agent', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/phase-5-small.png' });
  expect(
    await page.getByRole('button', { name: 'Discuss with agent', exact: true }).evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }),
  ).toBe(true);
  await page.getByRole('button', { name: 'Discuss with agent', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'References', exact: true })).not.toBeVisible();
  await expect(page.getByPlaceholder('Ask anything')).toHaveValue(/Evidence level: abstract only/);
  await expect(page.getByPlaceholder('Ask anything')).toHaveValue(/10.0000\/synthetic/);
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe(source);
});
test('stale source is rejected with no bibliography overwrite and Escape returns focus', async () => {
  await cursor();
  await references();
  await page.locator('.reference-result').click();
  await page.screenshot({ path: 'artifacts/phase-5-references.png' });
  await writeFile(
    join(root, 'main.tex'),
    source.replace('A synthetic claim.', 'A newer human claim.'),
  );
  // Hold recovery inspection after the real service result so Escape reaches the busy boundary.
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      }
    )._invokeHandlers;
    const original = handlers.get('loom:research:command')!;
    ipcMain.removeHandler('loom:research:command');
    ipcMain.handle('loom:research:command', async (event, command) => {
      const result = await original(event, command);
      if (command.type === 'recovery' && command.action === 'inspect')
        await new Promise<void>((resolve) => {
          ipcMain.once('loom:test:release-reference-recovery', () => resolve());
        });
      return result;
    });
  });
  await page.getByRole('button', { name: 'Insert citation', exact: true }).click();
  await expect(page.locator('.references .inline-error')).toContainText('source changed');
  expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(bib);
  const dialog = page.getByRole('dialog', { name: 'References', exact: true });
  await expect
    .poll(() =>
      app.evaluate(({ ipcMain }) => ipcMain.listenerCount('loom:test:release-reference-recovery')),
    )
    .toBe(1);
  await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await app.evaluate(({ ipcMain }) => ipcMain.emit('loom:test:release-reference-recovery'));
  // The error is rendered before recovery inspection finishes. Wait for the close guard to clear.
  await expect(dialog.getByRole('button', { name: 'Insert citation', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'References', exact: true })).toBeFocused();
  expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(bib);
});

test('local Zotero fixture imports an explicit record and preserves its original fields', async () => {
  const { createServer } = await import('node:http');
  const requests: string[] = [];
  const exported =
    '@article{Zotero2025,title={Zotero fixture paper},author={Scientist, Bea},year={2025},journal={Fixture Journal},doi={10.0000/zotero-fixture},custom={keep original}}';
  const server = createServer((req, res) => {
    requests.push(req.method + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify([
        {
          key: 'FIXTURE1',
          data: {
            itemType: 'journalArticle',
            title: 'Zotero fixture paper',
            date: '2025',
            DOI: '10.0000/zotero-fixture',
            creators: [{ firstName: 'Bea', lastName: 'Scientist' }],
            abstractNote: 'Synthetic abstract.',
          },
          bibtex: exported,
        },
      ]),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(23119, 'localhost', resolve);
    });
  } catch {
    server.close();
    test.skip(true, 'Local Zotero port is occupied; do not replace a running library.');
    return;
  }
  try {
    await cursor();
    await references();
    await page.getByRole('button', { name: 'Zotero', exact: true }).click();
    await page.getByLabel('Search references', { exact: true }).fill('fixture');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: /Zotero fixture paper/ }).click();
    await page.getByText('BibTeX preview', { exact: true }).click();
    await expect(page.locator('.reference-detail pre')).toContainText('custom={keep original}');
    await page.getByRole('button', { name: 'Import and cite', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'References', exact: true })).not.toBeVisible();
    await expect
      .poll(() => readFile(join(root, 'main.tex'), 'utf8'))
      .toContain('\\cite{Zotero2025}');
    expect((await readFile(join(root, 'refs.bib'), 'utf8')).startsWith(bib)).toBe(true);
    expect(await readFile(join(root, 'refs.bib'), 'utf8')).toContain('custom={keep original}');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('GET /api/users/0/items/top?');
    expect(requests[0]).toContain('include=data%2Cbibtex');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('live arXiv record can be inspected, cited and compiled without duplicate import', async () => {
  test.skip(process.env.LOOM_RESEARCH_LIVE !== '1', 'Opt-in real arXiv and installed TeX check.');
  test.setTimeout(90000);
  await cursor();
  await references();
  await page.getByRole('button', { name: 'arXiv', exact: true }).click();
  await page.getByLabel('Search references', { exact: true }).fill('1706.03762');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('button', { name: /^Attention Is All You Need/ })
    .first()
    .click({ timeout: 25000 });
  await expect(page.locator('.reference-detail')).toContainText('https://arxiv.org/abs/1706.03762');
  await expect(
    page.getByText('Abstract only · full text not inspected', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Import and cite', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'References', exact: true })).not.toBeVisible();
  const written = await readFile(join(root, 'refs.bib'), 'utf8');
  expect(written).toContain('1706.03762');
  expect(written.startsWith(bib)).toBe(true);
  await page.locator('.compile-source').click();
  await expect(page.locator('.build-status')).toHaveText('PDF ready', { timeout: 45000 });
  await references(2);
  await page.getByLabel('Search references', { exact: true }).fill('Attention Is All You Need');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('.reference-result').click();
  await page.getByRole('button', { name: 'Insert citation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'References', exact: true })).not.toBeVisible();
  expect(await readFile(join(root, 'refs.bib'), 'utf8')).toBe(written);
  await page.screenshot({ path: 'artifacts/phase-5-live-compiled.png' });
});
