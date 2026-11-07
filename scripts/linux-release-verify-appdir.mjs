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
for (const [source, packaged] of [
  ['../LICENSE', 'Loom-LICENSE.txt'],
  ['../THIRD_PARTY_NOTICES.md', 'README.md'],
  ['../design/brand/fonts/OFL.txt', 'Manrope-OFL.txt'],
  ['../src/renderer/ui/provider-assets/README.md', 'provider-marks.md'],
]) {
  const original = await readFile(fileURLToPath(new URL(source, import.meta.url)));
  const included = await readFile(join(directory, 'resources', 'notices', packaged));
  if (!original.equals(included))
    throw new Error(`Packaged notice differs from source: ${packaged}`);
}
await access(join(directory, 'LICENSE.electron.txt'));
await access(join(directory, 'LICENSES.chromium.html'));
console.log('Packaged launcher, desktop command, and distribution notices verified.');
