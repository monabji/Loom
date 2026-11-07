import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function sha256(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

export async function createChecksum(artifactPath, checksumPath = `${artifactPath}.sha256`) {
  const digest = await sha256(artifactPath);
  await writeFile(checksumPath, `${digest}  ${basename(artifactPath)}\n`);
  return digest;
}

export async function verifyChecksum(artifactPath, checksumPath = `${artifactPath}.sha256`) {
  const contents = await readFile(checksumPath, 'utf8');
  const match = /^([a-f\d]{64})  (.+)\n?$/.exec(contents);
  if (!match || match[2] !== basename(artifactPath)) {
    throw new Error(`Invalid SHA-256 checksum file for ${basename(artifactPath)}`);
  }

  const actual = await sha256(artifactPath);
  if (actual !== match[1]) throw new Error(`SHA-256 mismatch for ${basename(artifactPath)}`);
  return true;
}

async function main([command, artifactPath, checksumPath]) {
  if (!['create', 'verify'].includes(command) || !artifactPath) {
    throw new Error(
      'Usage: node scripts/linux-release-checksum.mjs <create|verify> <artifact> [checksum-file]',
    );
  }

  if (command === 'create') {
    const digest = await createChecksum(artifactPath, checksumPath);
    console.log(`${digest}  ${basename(artifactPath)}`);
    return;
  }

  await verifyChecksum(artifactPath, checksumPath);
  console.log(`SHA-256 verified: ${basename(artifactPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
