/**
 * Tiny {{dotted.path}} renderer. Unknown or empty paths become an empty
 * string so a missing sensor does not leak the placeholder to the phone.
 */
export function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => {
    const v = lookup(ctx, path)
    if (v === undefined || v === null) return ''
    return String(v)
  })
}

export function lookup(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
