/** Mask a secret for the API: keep the last four characters, never the rest. */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null
  if (value.length <= 4) return '••••'
  return `••••${value.slice(-4)}`
}

export function hasSecret(value: string | undefined | null): boolean {
  return !!value && value.length > 0
}

/** Drop known secret values from a log line so tokens never reach the journal. */
export function redactSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text
  for (const s of secrets) {
    if (!s || s.length < 4) continue
    out = out.split(s).join('••••')
  }
  return out
}
