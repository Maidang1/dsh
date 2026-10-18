import type { AdapterMode, EnvironmentSnapshot } from '@harness-explorer/contracts'

/** Environment variables a run may read, by adapter mode. Values never leave Node. */
export const RUN_VARIABLES: Record<AdapterMode, Array<{ name: string; sensitive: boolean }>> = {
  deterministic: [],
  real: [
    { name: 'DEEPSEEK_API_KEY', sensitive: true },
    { name: 'DEEPSEEK_BASE_URL', sensitive: false },
  ],
}

export const WORKSPACE_PLACEHOLDER = '<workspace>'

/**
 * Snapshot only the variables this run uses, as presence flags. The absolute
 * working directory is replaced before the snapshot reaches the browser or disk.
 */
export function captureEnvironment(mode: AdapterMode, env: NodeJS.ProcessEnv = process.env): EnvironmentSnapshot {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    cwd: WORKSPACE_PLACEHOLDER,
    modelProvider: mode === 'real' ? 'deepseek' : null,
    variables: RUN_VARIABLES[mode].map(({ name, sensitive }) => ({ name, present: Boolean(env[name]), sensitive })),
  }
}

/** Replace the workspace path and any known secret values inside text bound for the browser or disk. */
export function redactText(text: string, secrets: readonly string[], workspace = process.cwd()): string {
  let result = text.split(workspace).join(WORKSPACE_PLACEHOLDER)
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join('<redacted>')
  }
  return result
}

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.values(RUN_VARIABLES).flat()
    .filter(variable => variable.sensitive)
    .map(variable => env[variable.name])
    .filter((value): value is string => Boolean(value))
}
