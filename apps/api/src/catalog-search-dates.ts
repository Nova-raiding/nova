import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

/**
 * Validate and normalize catalog time filters before either PostgreSQL or the
 * in-memory fallback sees them. The memory repository compares timestamp
 * strings, so accepting timezone-less/loosely parsed values can produce a
 * different result from PostgreSQL's timestamptz comparison.
 */
export function normalizeCatalogDateRange(dateFrom: unknown, dateTo: unknown): { dateFrom?: string; dateTo?: string } {
  const from = normalizeCatalogDate(dateFrom, 'date_from')
  const to = normalizeCatalogDate(dateTo, 'date_to')
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'date_from 不能晚于 date_to', 400)
  }
  return { ...(from ? { dateFrom: from } : {}), ...(to ? { dateTo: to } : {}) }
}

function normalizeCatalogDate(value: unknown, field: 'date_from' | 'date_to'): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(field)

  // Millisecond precision matches JavaScript Date and the API's timestamp
  // representation; accepting finer database precision here would make the
  // memory path truncate filter instants that PostgreSQL can still compare.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match) throw invalid(field)
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const daysInMonth = month >= 1 && month <= 12
    ? [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
    : 0
  const offsetValid = zone === 'Z' || (() => {
    const offset = /[+-](\d{2}):(\d{2})$/u.exec(zone!)
    // PostgreSQL's timestamptz parser accepts numeric offsets through 15:59;
    // reject larger values here so malformed-but-JS-parseable strings cannot
    // fail only on the durable repository path.
    return Boolean(offset && Number(offset[1]) <= 15 && Number(offset[2]) <= 59)
  })()
  if (year < 1 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || !offsetValid || zone === '-00:00') throw invalid(field)

  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) throw invalid(field)
  const normalized = new Date(epoch).toISOString()
  // RFC 3339's -00:00 means that the local offset is unknown, not UTC. Also,
  // an otherwise valid local year near the endpoints may normalize into year
  // 0000 or 10000, outside the supported four-digit PostgreSQL/API range.
  if (!/^\d{4}-/u.test(normalized) || Number(normalized.slice(0, 4)) < 1) throw invalid(field)
  return normalized
}

function invalid(field: string) {
  return new DomainError(ERROR_CODES.INVALID_REQUEST, `${field} 必须是带时区的合法 ISO 8601 时间`, 400)
}
