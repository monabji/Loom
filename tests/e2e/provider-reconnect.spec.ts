import { resumeFromLibrary } from './helpers/project-library';
import { electronLaunchOptions } from './helpers/launch';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Native connection/session metadata only: never sends a model request.
for (const harness of ['codex', 'opencode'] as const) {
  const name = harness === 'codex' ? 'Codex' : 'OpenCode';
  test(`native ${name} reconnects after full application reopen and honors Disconnect`, async () => {
    test.skip(
      process.env.LOOM_NATIVE_RECONNECT !== '1',
      'Requires authorized installed native runtimes.',
    );
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), 'loom-native-reconnect-'));
    const root = join(directory, 'paper');
    const source = 'Synthetic reconnect manuscript.\n';
    let app: ElectronApplication | undefined;
    let page: Page;
    const launch = async () => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.ELECTRON_RENDERER_URL;
      app = await _electron.launch({
        chromiumSandbox: true,
        ...electronLaunchOptions(process.env, [`--user-data-dir=${join(directory, 'data')}`]),
        env,
      });
      page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await expect
        .poll(async () => {
          const result = await page.evaluate(() => window.loom!.getStatus());
          return result.ok && result.value.state;
        })
        .toBe('ready');
      await expect(page.getByRole('main', { name: 'Your projects' })).toHaveAttribute(
        'aria-busy',
        'false',
      );
      if ((await page.locator('.library-project').count()) > 0) await resumeFromLibrary(page);
    };
    try {
      await mkdir(root);
      await writeFile(join(root, 'main.tex'), source);
      await launch();
      await app!.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, root);
      await page!
        .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
        .click();
      await page!
        .getByRole('dialog', { name: 'Projects', exact: true })
        .getByRole('button', { name: 'Open folder', exact: true })
        .click();
      await expect(page!.getByRole('textbox', { name: 'LaTeX source editor' })).toContainText(
        source.trim(),
      );
      const project = await page!.evaluate(() => window.loom!.project({ type: 'current' }));
      if (!project.ok || !project.value) throw new Error('Synthetic project unavailable');
      const projectId = project.value.id;
      const connected = await page!.evaluate(
        ({ projectId, harness }) => window.loom!.agent({ type: 'connect', projectId, harness }),
        { projectId, harness },
      );
      expect(connected.ok).toBe(true);
      if (!connected.ok) throw new Error(connected.error.message);
      expect(connected.value.connection).toBe('connected');
      const sessionId = null;
      await app!.close();
      app = undefined;
      await launch();
      await expect
        .poll(
          async () => {
            const result = await page!.evaluate(
              (projectId) => window.loom!.agent({ type: 'status', projectId }),
              projectId,
            );
            return result.ok
              ? {
                  connection: result.value.connection,
                  sessionId: result.value.sessionId,
                  unavailable: !!result.value.sessionUnavailable,
                  running: result.value.running,
                  error: result.value.error,
                }
              : result.error.message;
          },
          { timeout: 25_000 },
        )
        .toEqual({
          connection: 'connected',
          sessionId,
          unavailable: false,
          running: false,
          error: '',
        });
      await page!.getByRole('button', { name: 'Agent connections', exact: true }).click();
      const dialog = page!.getByRole('dialog', { name: 'Agent connections', exact: true });
      await expect(dialog.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
      await page!.screenshot({
        path: `artifacts/beta-native-${harness}-reconnected.png`,
        animations: 'disabled',
      });
      await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(
        dialog.getByRole('button', { name: `Connect ${name}`, exact: true }),
      ).toBeVisible();
      await app!.close();
      app = undefined;
      await launch();
      const disconnected = await page!.evaluate(
        (projectId) => window.loom!.agent({ type: 'status', projectId }),
        projectId,
      );
      expect(disconnected.ok && disconnected.value.connection).toBe('disconnected');
      expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe(source);
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
