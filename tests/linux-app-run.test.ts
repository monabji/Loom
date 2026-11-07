import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it.skipIf(process.platform !== 'linux')(
  'AppRun preserves arguments and never retries a failed sandbox launch without sandboxing',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'loom launcher é '));
    try {
      await copyFile(resolve('scripts/linux-app-run.sh'), join(directory, 'AppRun'));
      await mkdir(join(directory, 'usr', 'lib'), { recursive: true });
      await writeFile(
        join(directory, 'loom'),
        '#!/bin/bash\nprintf "%s\\n" "$@"\nprintf "libraries=%s\\n" "$LD_LIBRARY_PATH"\nexit 42\n',
        { mode: 0o755 },
      );
      const env: NodeJS.ProcessEnv = { ...process.env, LD_LIBRARY_PATH: '/fixture/libs' };
      delete env.APPDIR;
      const result = spawnSync('bash', [join(directory, 'AppRun'), 'paper with spaces.tex', 'é'], {
        env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(42);
      expect(result.stdout.split('\n')).toEqual([
        'paper with spaces.tex',
        'é',
        `libraries=${directory}/usr/lib:/fixture/libs`,
        '',
      ]);
      expect(result.stderr).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
