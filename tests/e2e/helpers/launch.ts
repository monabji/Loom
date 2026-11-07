import { resolve } from 'node:path';

export function electronLaunchOptions(
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  fallbackExecutablePath?: string,
): { executablePath?: string; args: string[] } {
  const executablePath =
    env.LOOM_E2E_EXECUTABLE ||
    (env.LOOM_AGENT_PACKAGED === '1' ? resolve('release/linux-unpacked/loom') : undefined) ||
    fallbackExecutablePath;

  return {
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : [resolve('out/main/index.js')]), ...args],
  };
}

export function isPackagedElectron(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.LOOM_E2E_EXECUTABLE) || env.LOOM_AGENT_PACKAGED === '1';
}
