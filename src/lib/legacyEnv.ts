/**
 * Read a THRYVE_* setting, falling back to the matching SEEDYPOD_* name so a
 * unit mid-migration from seedypod still starts. THRYVE_* always wins.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]
  if (v !== undefined && v !== '') return v
  if (name.startsWith('THRYVE_')) {
    const legacy = env[`SEEDYPOD_${name.slice('THRYVE_'.length)}`]
    if (legacy !== undefined && legacy !== '') return legacy
  }
  return undefined
}
