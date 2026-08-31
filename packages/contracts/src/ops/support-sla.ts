import type { SupportTicketEventType, SupportTicketPriority } from './support.js'

export type SupportSlaState = 'on_track' | 'at_risk' | 'breached' | 'met'

export interface SupportSlaPolicySnapshot {
  version: number
  calendar: 'business_weekday_utc'
  firstResponseMinutes: number
  resolutionMinutes: number
}

export interface SupportSlaProjection {
  policy: SupportSlaPolicySnapshot
  firstResponseDueAt: string
  resolutionDueAt: string
  firstResponseAt?: string
  resolvedAt?: string
  pausedMinutes: number
  pauseStartedAt?: string
  state: SupportSlaState
}

export interface SupportSlaEventLike {
  eventType: SupportTicketEventType
  payload: Readonly<Record<string, unknown>>
  createdAt: string
}

const policyMinutes: Record<SupportTicketPriority, Pick<SupportSlaPolicySnapshot, 'firstResponseMinutes' | 'resolutionMinutes'>> = {
  urgent: { firstResponseMinutes: 120, resolutionMinutes: 480 },
  high: { firstResponseMinutes: 240, resolutionMinutes: 1440 },
  normal: { firstResponseMinutes: 480, resolutionMinutes: 2880 },
  low: { firstResponseMinutes: 960, resolutionMinutes: 5760 },
}

export const SUPPORT_SLA_POLICY_VERSION = 1

export function supportSlaPolicyFor(priority: SupportTicketPriority): SupportSlaPolicySnapshot {
  return Object.freeze({ version: SUPPORT_SLA_POLICY_VERSION, calendar: 'business_weekday_utc', ...policyMinutes[priority] })
}

function isBusinessMinute(value: Date): boolean {
  const day = value.getUTCDay()
  const hour = value.getUTCHours()
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18
}

function nextBusinessMinute(value: Date): Date {
  const next = new Date(value)
  next.setUTCSeconds(0, 0)
  while (!isBusinessMinute(next)) {
    next.setUTCMinutes(next.getUTCMinutes() + 1)
  }
  return next
}

export function addBusinessMinutes(start: Date, minutes: number): Date {
  if (!Number.isInteger(minutes) || minutes < 1) throw new RangeError('SUPPORT_SLA_MINUTES_INVALID')
  let cursor = nextBusinessMinute(start)
  let remaining = minutes
  while (remaining > 0) {
    cursor = nextBusinessMinute(cursor)
    const endOfDay = new Date(cursor)
    endOfDay.setUTCHours(18, 0, 0, 0)
    const available = Math.max(0, Math.floor((endOfDay.getTime() - cursor.getTime()) / 60000))
    if (remaining <= available) {
      cursor = new Date(cursor.getTime() + remaining * 60000)
      remaining = 0
    } else {
      remaining -= available
      cursor = new Date(endOfDay.getTime() + 60000)
    }
  }
  return cursor
}

export function deriveSupportSlaState(input: Pick<SupportSlaProjection, 'firstResponseDueAt' | 'resolutionDueAt' | 'firstResponseAt' | 'resolvedAt'>, now = new Date()): SupportSlaState {
  if (input.resolvedAt) return 'met'
  if (Date.parse(input.resolutionDueAt) <= now.getTime()) return 'breached'
  if (Date.parse(input.firstResponseDueAt) <= now.getTime() && !input.firstResponseAt) return 'at_risk'
  const resolutionRemaining = Date.parse(input.resolutionDueAt) - now.getTime()
  return resolutionRemaining <= 2 * 60 * 60 * 1000 ? 'at_risk' : 'on_track'
}

function isBusinessMinuteValue(value: Date): boolean {
  return isBusinessMinute(value)
}

function businessMinutesBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0
  const cursor = new Date(start)
  cursor.setUTCSeconds(0, 0)
  const finish = end.getTime()
  let minutes = 0
  while (cursor.getTime() < finish) {
    if (isBusinessMinuteValue(cursor)) minutes += 1
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  }
  return minutes
}

/** Rebuilds SLA facts from immutable ticket events. Customer-visible comments are the only human response signal. */
export function projectSupportSlaFromEvents(
  base: SupportSlaProjection,
  events: readonly SupportSlaEventLike[],
  now = new Date(),
): SupportSlaProjection {
  let firstResponseAt: string | undefined
  let resolvedAt: string | undefined
  let pauseStartedAt: string | undefined
  let pausedMinutes = 0
  for (const event of events) {
    if (event.eventType === 'commented' && event.payload.visibility === 'customer' && !firstResponseAt) firstResponseAt = event.createdAt
    if (event.eventType === 'status_changed') {
      const to = typeof event.payload.to === 'string' ? event.payload.to : undefined
      // A reopened ticket must re-enter the active SLA clock. Keeping the
      // historical resolvedAt would make the projection permanently `met`
      // and hide a later breach. The immutable event stream remains the source
      // of truth; a subsequent resolved/closed event can set it again.
      if (resolvedAt && (to === 'open' || to === 'in_progress' || to === 'waiting_customer')) resolvedAt = undefined
      if (to === 'waiting_customer' && !pauseStartedAt) pauseStartedAt = event.createdAt
      if (pauseStartedAt && to !== 'waiting_customer') {
        pausedMinutes += businessMinutesBetween(new Date(pauseStartedAt), new Date(event.createdAt))
        pauseStartedAt = undefined
      }
      if ((to === 'resolved' || to === 'closed') && !resolvedAt) resolvedAt = event.createdAt
    }
  }
  if (pauseStartedAt) pausedMinutes += businessMinutesBetween(new Date(pauseStartedAt), now)
  const resolutionDueAt = pausedMinutes > 0
    ? addBusinessMinutes(new Date(base.resolutionDueAt), pausedMinutes).toISOString()
    : base.resolutionDueAt
  const projected = {
    ...base,
    resolutionDueAt,
    ...(firstResponseAt ? { firstResponseAt } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
    pausedMinutes,
    ...(pauseStartedAt ? { pauseStartedAt } : {}),
    state: deriveSupportSlaState({ ...base, resolutionDueAt, firstResponseAt, resolvedAt }, now),
  }
  return projected
}

export function createSupportSlaProjection(priority: SupportTicketPriority, createdAt: Date): SupportSlaProjection {
  const policy = supportSlaPolicyFor(priority)
  const firstResponseDueAt = addBusinessMinutes(createdAt, policy.firstResponseMinutes).toISOString()
  const resolutionDueAt = addBusinessMinutes(createdAt, policy.resolutionMinutes).toISOString()
  return Object.freeze({ policy, firstResponseDueAt, resolutionDueAt, pausedMinutes: 0, state: deriveSupportSlaState({ firstResponseDueAt, resolutionDueAt }, createdAt) })
}

/** The reporting cutoff is the start of the third UTC business day after the
 * closed calendar period. It is deterministic so UI, API and Worker cannot
 * silently disagree about when a report becomes due. */
export function supportSlaReportCutoffAt(periodEnd: string): string {
  const parsed = Date.parse(periodEnd)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== periodEnd) throw new RangeError('SUPPORT_SLA_REPORT_PERIOD_END_INVALID')
  const cursor = new Date(parsed)
  cursor.setUTCHours(0, 0, 0, 0)
  let businessDays = 0
  while (businessDays < 3) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) businessDays += 1
    if (businessDays < 3) cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return cursor.toISOString()
}
