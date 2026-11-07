import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('creates and verifies an artifact checksum, then rejects changed bytes', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-release-checksum-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const artifact = join(directory, 'Loom-0.1.0.AppImage');
  await writeFile(artifact, 'original AppImage bytes');

  execFileSync(process.execPath, [
    resolve('scripts/linux-release-checksum.mjs'),
    'create',
    artifact,
  ]);
  assert.match(
    execFileSync(
      process.execPath,
      [resolve('scripts/linux-release-checksum.mjs'), 'verify', artifact],
      { encoding: 'utf8' },
    ),
    /SHA-256 verified/,
  );

  await writeFile(artifact, 'changed AppImage bytes');
  const tampered = spawnSync(
    process.execPath,
    [resolve('scripts/linux-release-checksum.mjs'), 'verify', artifact],
    { encoding: 'utf8' },
  );
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /SHA-256 mismatch/);
});
