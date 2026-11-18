import { trpc } from '@/src/utils/trpc'

/** The unit's name and a one-line status under it: HAL model, core version, online. */
export function useCoreStatus(): { name: string, line: string, online: boolean } {
  const info = trpc.system.info.useQuery(undefined, { refetchInterval: 30_000 })
  const settings = trpc.settings.get.useQuery()
  const name = settings.data?.unitName ?? 'thryve'
  const unauthorized = (info.error as { data?: { httpStatus?: number } } | null)?.data?.httpStatus === 401
  if (!info.data) return { name, line: info.isError ? (unauthorized ? 'sign in required' : 'core unreachable') : '…', online: false }
  const { coreVersion, halOnline, system } = info.data
  return { name, line: `${system?.model ?? 'no HAL'} · core ${coreVersion} · ${halOnline ? 'online' : 'offline'}`, online: halOnline }
}
