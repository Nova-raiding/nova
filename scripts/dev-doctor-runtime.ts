export type ComposeServiceState = {
  Service?: unknown
  State?: unknown
  Health?: unknown
  Status?: unknown
}

export function parseComposeServiceStates(output: string): ComposeServiceState[] {
  const value = output.trim()
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item === 'object') as ComposeServiceState[]
    if (parsed && typeof parsed === 'object') return [parsed as ComposeServiceState]
  } catch {
    const rows: ComposeServiceState[] = []
    for (const line of value.split(/\r?\n/u).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as ComposeServiceState)
      } catch { return [] }
    }
    return rows
  }
  return []
}

export function composeServiceHealth(rows: ComposeServiceState[], service: string) {
  const row = rows.find(item => item.Service === service)
  if (!row) return { present: false, healthy: false, detail: 'not running' }
  const state = typeof row.State === 'string' ? row.State.toLowerCase() : ''
  const health = typeof row.Health === 'string' ? row.Health.toLowerCase() : ''
  const status = typeof row.Status === 'string' ? row.Status : ''
  return {
    present: true,
    healthy: state === 'running' && health === 'healthy',
    detail: status || [state, health].filter(Boolean).join('/'),
  }
}

export function releaseReadiness(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.ready === 'boolean') return record.ready
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return undefined
  const ready = (record.data as Record<string, unknown>).ready
  return typeof ready === 'boolean' ? ready : undefined
}
