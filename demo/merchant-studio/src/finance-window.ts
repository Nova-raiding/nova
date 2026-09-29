export type FinancePoint = { label: string; value: number; dateLabel?: string }

export function filterFinanceEntriesByWindow<T extends { createdAt: string }>(entries: T[], mode: 'day' | 'month', start: string, end: string): T[] {
  const normalize = (value: string) => mode === 'day' ? value.replaceAll('-', '') : value.replace('-', '')
  const from = normalize(start)
  const to = normalize(end)
  return entries.filter((entry) => {
    const date = shanghaiCalendarDate(new Date(entry.createdAt))
    if (!date) return false
    const key = normalize(mode === 'day' ? date : date.slice(0, 7))
    return (!from || key >= from) && (!to || key <= to)
  })
}

const shanghaiCalendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})

export function shanghaiCalendarDate(date: Date): string | null {
  if (!Number.isFinite(date.getTime())) return null
  const parts = Object.fromEntries(shanghaiCalendar.formatToParts(date).map(({ type, value }) => [type, value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  if (![year, month, day].every(Number.isFinite)) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function currentShanghaiMonthRange(now = new Date()): { start: string; end: string; days: number } {
  const today = shanghaiCalendarDate(now)
  if (!today) throw new Error('FINANCE_WINDOW_DATE_INVALID')
  const [year, month] = today.split('-').map(Number)
  const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate()
  return {
    start: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`,
    end: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(days).padStart(2, '0')}`,
    days,
  }
}

export function fillDailyFinancePoints(points: FinancePoint[], start: string, end: string): FinancePoint[] {
  if (points.length === 0) return []
  const from = Date.parse(`${start.replaceAll('/', '-')}T00:00:00.000Z`)
  const to = Date.parse(`${end.replaceAll('/', '-')}T00:00:00.000Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return points
  const count = Math.floor((to - from) / 86_400_000) + 1
  if (count > 366) return points
  const byDate = new Map(points.flatMap(point => point.dateLabel ? [[point.dateLabel.replaceAll('/', '-'), point] as const] : []))
  return Array.from({ length: count }, (_, index) => {
    const dateLabel = new Date(from + index * 86_400_000).toISOString().slice(0, 10)
    return byDate.get(dateLabel) ?? { dateLabel, label: dateLabel.slice(5).replace('-', '/'), value: 0 }
  })
}
