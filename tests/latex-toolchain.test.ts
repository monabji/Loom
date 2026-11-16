import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findLatexExecutable, latexEnvironment } from '../src/services/latex/tools';

it.skipIf(process.arch !== 'x64' || !['win32', 'linux'].includes(process.platform))(
  'finds the user TeX toolchain and includes its executables in the compiler environment',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'loom-tex-discovery-'));
    const windows = process.platform === 'win32';
    const localAppData = join(home, 'Local');
    const bin = windows
      ? join(localAppData, 'LoomToolchain', 'TinyTeX', 'bin', 'windows')
      : join(home, '.TinyTeX', 'bin', 'x86_64-linux');
    const texlab = windows
      ? join(localAppData, 'LoomToolchain', 'texlab')
      : join(home, '.local', 'share', 'loom', 'bin');
    const executable = (name: string) => (windows ? name + '.exe' : name);
    try {
      await mkdir(bin, { recursive: true });
      await mkdir(texlab, { recursive: true });
      await writeFile(join(bin, executable('pdflatex')), '', { mode: 0o755 });
      await writeFile(join(texlab, executable('texlab')), '', { mode: 0o755 });
      const options = { home, localAppData, path: join(home, 'no-system-tools') };
      expect(await findLatexExecutable('pdflatex', options)).toBe(
        join(bin, executable('pdflatex')),
      );
      expect(await findLatexExecutable('texlab', options)).toBe(join(texlab, executable('texlab')));
      expect(latexEnvironment(options).PATH?.split(delimiter)).toEqual([options.path, bin, texlab]);
      expect(
        await findLatexExecutable('pdflatex', {
          ...options,
          override: ['.', options.path].join(delimiter),
        }),
      ).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
