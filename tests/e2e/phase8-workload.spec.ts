import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { electronLaunchOptions } from './helpers/launch';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workload = process.env.LOOM_PHASE8_PROJECT;
test.skip(!workload, 'Set LOOM_PHASE8_PROJECT to a generated Phase 8 workload folder.');

let app: ElectronApplication;
let page: Page;
let userData: string;
let runDirectory: string;

function processTree(pid: number): Array<{ pid: number; ppid: number; rssKb: number }> {
  const records = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length === 3)
    .map(([child, parent, rss]) => ({ pid: child!, ppid: parent!, rssKb: rss! }));
  const tree = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (tree.has(record.ppid) && !tree.has(record.pid)) {
        tree.add(record.pid);
        changed = true;
      }
    }
  }
  return records.filter((record) => tree.has(record.pid));
}

async function memorySnapshot(pid: number) {
  const processes = await Promise.all(
    processTree(pid).map(async (record) => {
      let pssKb: number | null = null;
      try {
        const rollup = await readFile(`/proc/${record.pid}/smaps_rollup`, 'utf8');
        const match = /^Pss:\s+(\d+) kB$/m.exec(rollup);
        if (match) pssKb = Number(match[1]);
      } catch {
        // Permissions or a process exit can make proportional accounting unavailable.
      }
      return { ...record, pssKb };
    }),
  );
  const completePss = processes.length > 0 && processes.every((record) => record.pssKb !== null);
  return {
    processes,
    processTreePssMb: completePss
      ? processes.reduce((sum, record) => sum + record.pssKb!, 0) / 1024
      : null,
    processTreeRssSumMb: processes.reduce((sum, record) => sum + record.rssKb, 0) / 1024,
    accounting: completePss
      ? 'PSS available for every sampled process'
      : 'RSS sum fallback; shared memory may be counted multiple times',
  };
}

function cpuTicks(pid: number): number {
  const pids = processTree(pid).map((record) => record.pid);
  return pids.reduce((sum, child) => {
    try {
      const stat = execFileSync('cat', [`/proc/${child}/stat`], { encoding: 'utf8' });
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      return sum + Number(fields[11]) + Number(fields[12]);
    } catch {
      return sum;
    }
  }, 0);
}

test('opens and measures the packaged Phase 8 synthetic workload', async () => {
  test.setTimeout(180_000);
  if (!workload) throw new Error('Missing LOOM_PHASE8_PROJECT.');
  const largeFilePath = join(workload, 'sections', 'large-file.tex');
  const originalLargeFile = await readFile(largeFilePath);
  expect(
    originalLargeFile
      .toString('utf8')
      .includes('% large-file line 9999: synthetic navigation workload'),
    'The workload must contain the generated search target before launch; a previous benchmark may have overwritten it.',
  ).toBe(true);
  runDirectory = await mkdtemp(join(tmpdir(), 'loom-phase-8-workload-'));
  userData = join(runDirectory, 'user-data');
  const projectCopy = join(runDirectory, 'project');
  // Typing replaces the selected search match and is saved to disk. Always
  // measure a private copy so repeat runs use identical, untouched inputs.
  await cp(workload, projectCopy, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;

  const launchStart = performance.now();
  const launchOptions = electronLaunchOptions(
    process.env,
    [`--user-data-dir=${userData}`],
    resolve('release/linux-unpacked/loom'),
  );
  const executable = launchOptions.executablePath ?? resolve('out/main/index.js');
  app = await _electron.launch({
    ...launchOptions,
    chromiumSandbox: true,
    env,
    timeout: 30_000,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(async () => {
      const status = await page.evaluate(() => window.loom!.getStatus());
      return status.ok ? status.value.state : status.error.code;
    })
    .toBe('ready');
  const launchToServiceReadyMs = performance.now() - launchStart;

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, projectCopy);
  const projectOpenStart = performance.now();
  await page
    .getByRole('button', { name: /^(Open or create project|More options)$/, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Open folder', exact: true })
    .click();
  const editor = page.getByRole('textbox', { name: 'LaTeX source editor' });
  await expect(editor).toContainText('Synthetic Phase 8 workload', { timeout: 60_000 });
  const projectOpenToEditorMs = performance.now() - projectOpenStart;

  const mainPid = app.process().pid;
  if (mainPid === undefined) throw new Error('Packaged Electron process PID is unavailable.');
  const memoryAtOpen = await memorySnapshot(mainPid);
  await page
    .getByRole('complementary', { name: 'Project sidebar', exact: true })
    .getByRole('button', { name: 'Search project', exact: true })
    .click();
  const projectSearch = page.getByRole('textbox', { name: 'Search project text', exact: true });
  const projectSearchStart = performance.now();
  await projectSearch.fill('large-file line 9999');
  await projectSearch.press('Enter');
  const results = page.getByRole('region', { name: 'Project search results' });
  const largeFileHit = results.getByRole('button').filter({ hasText: 'large-file.tex' }).first();
  await expect(largeFileHit).toBeVisible({ timeout: 60_000 });
  const projectSearchMs = performance.now() - projectSearchStart;
  const navigationStart = performance.now();
  await largeFileHit.click();
  await expect(editor).toContainText('large-file line 9999');
  const tenThousandLineOpenMs = performance.now() - navigationStart;

  await page.getByRole('button', { name: 'References', exact: true }).click();
  const referenceSearch = page.getByRole('textbox', { name: 'Search references', exact: true });
  await referenceSearch.fill('Synthetic research record 4999');
  const bibliographySearchStart = performance.now();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Synthetic research record 4999', { exact: false })).toBeVisible();
  const bibliographySearchMs = performance.now() - bibliographySearchStart;
  await page.keyboard.press('Escape');

  await editor.focus();
  const keyRaf = await page.evaluate(() => {
    const samples: number[] = [];
    const editorElement = document.querySelector('.cm-content');
    editorElement?.addEventListener(
      'keydown',
      () => {
        const started = performance.now();
        requestAnimationFrame(() => samples.push(performance.now() - started));
      },
      { capture: true },
    );
    (window as unknown as { __phase8KeyRaf?: number[] }).__phase8KeyRaf = samples;
    return true;
  });
  if (!keyRaf) throw new Error('Could not register typing-to-frame observer.');
  for (let index = 0; index < 50; index++) {
    await page.keyboard.press('x');
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __phase8KeyRaf?: number[] }).__phase8KeyRaf?.length,
        ),
      )
      .toBe(index + 1);
  }
  const typingToFrameMs = await page.evaluate(
    () => (window as unknown as { __phase8KeyRaf?: number[] }).__phase8KeyRaf ?? [],
  );

  // The saved label acknowledges the filesystem bridge, rather than only editor state.
  await expect(page.locator('.readonly-label')).toHaveText('Saved to disk', { timeout: 30_000 });
  expect((await readFile(largeFilePath)).equals(originalLargeFile)).toBe(true);
  expect(
    (await readFile(join(projectCopy, 'sections', 'large-file.tex'))).equals(originalLargeFile),
  ).toBe(false);
  const postSaveSettleMs = 3_000;
  await page.waitForTimeout(postSaveSettleMs);
  await expect(page.locator('.readonly-label')).toHaveText('Saved to disk');
  const memoryAfterInteraction = await memorySnapshot(mainPid);
  const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
    throw new Error('Could not determine Linux CPU ticks per second.');
  }
  const idleStartTicks = cpuTicks(mainPid);
  const idleStart = performance.now();
  await page.waitForTimeout(5_000);
  const idleMs = performance.now() - idleStart;
  const idleCpuPercentOfOneCore =
    ((cpuTicks(mainPid) - idleStartTicks) / ticksPerSecond / (idleMs / 1000)) * 100;

  const sortedTyping = [...typingToFrameMs].sort((a, b) => a - b);
  const p95 = sortedTyping[Math.ceil(sortedTyping.length * 0.95) - 1] ?? 0;
  const metrics = {
    executable,
    workload,
    viewport: page.viewportSize(),
    sampleCount: typingToFrameMs.length,
    launchToServiceReadyMs,
    projectOpenToEditorMs,
    projectTextSearchMs: projectSearchMs,
    tenThousandLineFileOpenMs: tenThousandLineOpenMs,
    bibliographySearchEndToEndUiMs: bibliographySearchMs,
    keydownToNextAnimationFrameMs: {
      p50: sortedTyping[Math.floor(sortedTyping.length * 0.5)] ?? 0,
      p95,
      max: sortedTyping.at(-1) ?? 0,
    },
    memorySnapshots: {
      afterProjectOpen: memoryAtOpen,
      afterInteractionsAndSettling: memoryAfterInteraction,
    },
    postSaveSettleMs,
    settledCpuWithPeriodicRefresh: {
      percentOfOneCore: idleCpuPercentOfOneCore,
      sampleDurationMs: idleMs,
      ticksPerSecond,
      projectRefreshIntervalMs: 1_000,
    },
    limitations: [
      'The supplied fixture is copied to a private temporary project before launch; copying warms filesystem caches and these timings do not measure cold I/O.',
      'The animation-frame delay is a renderer-side typing proxy, not display photon latency.',
      'Bibliography latency includes the UI action, IPC, project refresh, parsing, filtering and rendering; it is not isolated parsing or indexed-search performance.',
      'CPU includes Electron descendants after save acknowledgment and a settling delay; the one-second project refresh remains active. Process exits/starts can affect cumulative tick deltas.',
      'Memory snapshots use per-process Linux smaps_rollup PSS where readable; RSS is a process-tree sum that can double-count shared memory. Two snapshots do not establish memory growth, bounded caches or leaks.',
      'This run does not exercise the available local TeX toolchain, compile/agent-stream concurrency or repeated edit/build memory behavior.',
      'The generated 200-page PDF is an ordinary source-folder asset, not a PDF.js build snapshot.',
    ],
  };
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(
    resolve('artifacts/phase-8-workload-metrics.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  console.log(JSON.stringify(metrics, null, 2));
  expect(typingToFrameMs).toHaveLength(50);
});

test.afterEach(async () => {
  if (app) await app.close().catch(() => {});
  if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
});
