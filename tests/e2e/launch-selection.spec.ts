import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { electronLaunchOptions, isPackagedElectron } from './helpers/launch';

test('uses the explicit executable for packaged journeys', () => {
  const options = electronLaunchOptions({ LOOM_E2E_EXECUTABLE: '/tmp/Loom.AppImage' }, [
    '--user-data-dir=/tmp/loom-profile',
  ]);

  expect(options).toEqual({
    executablePath: '/tmp/Loom.AppImage',
    args: ['--user-data-dir=/tmp/loom-profile'],
  });
  expect(isPackagedElectron({ LOOM_E2E_EXECUTABLE: '/tmp/Loom.AppImage' })).toBe(true);
});

test('keeps the legacy packaged agent opt-in', () => {
  expect(electronLaunchOptions({ LOOM_AGENT_PACKAGED: '1' })).toEqual({
    executablePath: resolve('release/linux-unpacked/loom'),
    args: [],
  });
});

test('uses the source entry point without a packaged selector', () => {
  expect(electronLaunchOptions({})).toEqual({
    args: [resolve('out/main/index.js')],
  });
  expect(isPackagedElectron({})).toBe(false);
});
