const SHANGHAI_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function calendarDay(date: Date): number | null {
  if (!Number.isFinite(date.getTime())) return null
  const parts = Object.fromEntries(SHANGHAI_DATE.formatToParts(date).map(({ type, value }) => [type, value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? Date.UTC(year, month - 1, day) / 86_400_000
    : null
}

export function daysRemainingInShanghai(end: string, now = new Date()): number | null {
  const endDay = calendarDay(new Date(end))
  const today = calendarDay(now)
  return endDay === null || today === null ? null : Math.max(0, endDay - today)
}

export function yesterdayWindowInShanghai(now = new Date()): { date: string; dateFrom: string; dateTo: string } {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => dateParts.find((item) => item.type === type)?.value ?? ''
  const previousDay = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')) - 1))
  const date = previousDay.toISOString().slice(0, 10)
  return {
    date,
    dateFrom: `${date}T00:00:00+08:00`,
    dateTo: `${date}T23:59:59.999+08:00`,
  }
}
