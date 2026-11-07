import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2];
if (!directory) throw new Error('Pass the extracted AppImage directory.');
const expected = await readFile(fileURLToPath(new URL('./linux-app-run.sh', import.meta.url)));
const actual = await readFile(join(directory, 'AppRun'));
if (!actual.equals(expected))
  throw new Error('Packaged AppRun differs from the reviewed launcher.');
const desktop = await readFile(join(directory, 'org.loom.workspace.desktop'), 'utf8');
if (!/^Exec=AppRun %U$/m.test(desktop))
  throw new Error('Unexpected packaged desktop launch command.');
await access(join(directory, 'AppRun'), constants.X_OK);
await access(join(directory, 'loom'), constants.X_OK);
console.log('Packaged AppRun and desktop command match the reviewed sandbox-preserving launcher.');
