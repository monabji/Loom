import { constants, promises as fs } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { findExecutable } from '../latex/tools';

export async function harnessExecutable(name: string, override?: string): Promise<string | null> {
  if (!override) {
    const found = await findExecutable(name);
    if (found || process.platform !== 'win32') return found;
    return findWindowsHarnessExecutable(name, (process.env.PATH ?? '').split(delimiter));
  }
  if (!isAbsolute(override))
    throw new Error(
      'Use the full absolute path to the agent executable, or leave it empty for automatic detection.',
    );
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(override))
    throw new Error(
      'Select the native .exe file in Runtime settings; Windows command shims are not supported.',
    );
  try {
    if (process.platform === 'win32') await fs.access(override);
    else await fs.access(override, constants.X_OK);
    if ((await fs.stat(override)).isFile()) return override;
  } catch {
    /* Report one actionable error without exposing native command output. */
  }
  throw new Error(
    'The agent executable is not accessible. Check the binary path in Runtime settings.',
  );
}

/**
 * Find the native executable shipped with supported global npm installs.
 * Windows npm exposes .cmd/.ps1 shims on PATH; Loom deliberately launches a
 * native executable directly so arguments never pass through a shell.
 */
export async function findWindowsHarnessExecutable(
  name: string,
  pathDirectories: string[],
  arch = process.arch,
): Promise<string | null> {
  if (name !== 'codex' && name !== 'opencode') return null;
  const target =
    arch === 'arm64' ? 'aarch64-pc-windows-msvc' : arch === 'x64' ? 'x86_64-pc-windows-msvc' : null;
  if (!target) return null;
  for (const prefix of pathDirectories) {
    if (!isAbsolute(prefix)) continue;
    const root = join(prefix, 'node_modules');
    const candidates =
      name === 'codex'
        ? [
            join(
              root,
              '@openai',
              'codex-' + (arch === 'arm64' ? 'win32-arm64' : 'win32-x64'),
              'vendor',
              target,
              'bin',
              'codex.exe',
            ),
            join(
              root,
              '@openai',
              'codex',
              'node_modules',
              '@openai',
              'codex-' + (arch === 'arm64' ? 'win32-arm64' : 'win32-x64'),
              'vendor',
              target,
              'bin',
              'codex.exe',
            ),
            join(root, '@openai', 'codex', 'vendor', target, 'bin', 'codex.exe'),
          ]
        : [
            join(root, 'opencode-ai', 'bin', 'opencode.exe'),
            join(
              root,
              'opencode-windows-' + (arch === 'arm64' ? 'arm64' : 'x64'),
              'bin',
              'opencode.exe',
            ),
            join(
              root,
              'opencode-ai',
              'node_modules',
              'opencode-windows-' + (arch === 'arm64' ? 'arm64' : 'x64'),
              'bin',
              'opencode.exe',
            ),
          ];
    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch {
        /* Continue through the trusted global npm prefix layouts. */
      }
    }
  }
  return null;
}
