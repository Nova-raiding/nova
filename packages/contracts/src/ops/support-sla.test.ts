import { describe, expect, it } from 'vitest'
import { addBusinessMinutes, createSupportSlaProjection, deriveSupportSlaState, projectSupportSlaFromEvents, supportSlaPolicyFor, supportSlaReportCutoffAt } from './support-sla.js'

describe('support SLA policy and business clock', () => {
  it('binds priority to a versioned policy and skips weekends/out-of-hours', () => {
    const createdAt = new Date('2026-08-28T17:00:00.000Z') // Friday
    expect(addBusinessMinutes(createdAt, 120).toISOString()).toBe('2026-08-31T10:00:00.000Z')
    expect(createSupportSlaProjection('urgent', createdAt).policy).toEqual({
      version: 1, calendar: 'business_weekday_utc', firstResponseMinutes: 120, resolutionMinutes: 480,
    })
  })

  it('uses the stricter of first-response and resolution deadlines for state', () => {
    const policy = supportSlaPolicyFor('high')
    const projection = createSupportSlaProjection('high', new Date('2026-08-31T09:00:00.000Z'))
    expect(projection.policy).toEqual(policy)
    expect(deriveSupportSlaState(projection, new Date('2026-08-31T12:00:00.000Z'))).toBe('on_track')
    expect(deriveSupportSlaState(projection, new Date(projection.firstResponseDueAt))).toBe('at_risk')
    expect(deriveSupportSlaState(projection, new Date(projection.resolutionDueAt))).toBe('breached')
    expect(deriveSupportSlaState({ ...projection, resolvedAt: '2026-08-31T13:00:00.000Z' })).toBe('met')
  })

  it('counts the first customer-visible human comment and pauses resolution while waiting', () => {
    const base = createSupportSlaProjection('urgent', new Date('2026-08-31T09:00:00.000Z'))
    const projected = projectSupportSlaFromEvents(base, [
      { eventType: 'created', payload: {}, createdAt: '2026-08-31T09:00:00.000Z' },
      { eventType: 'status_changed', payload: { to: 'waiting_customer' }, createdAt: '2026-08-31T10:00:00.000Z' },
      { eventType: 'commented', payload: { visibility: 'internal' }, createdAt: '2026-08-31T11:00:00.000Z' },
      { eventType: 'status_changed', payload: { to: 'in_progress' }, createdAt: '2026-09-01T09:00:00.000Z' },
      { eventType: 'commented', payload: { visibility: 'customer' }, createdAt: '2026-09-01T10:00:00.000Z' },
    ], new Date('2026-09-01T10:00:00.000Z'))
    expect(projected.firstResponseAt).toBe('2026-09-01T10:00:00.000Z')
    expect(projected.pausedMinutes).toBe(480)
    expect(projected.pauseStartedAt).toBeUndefined()
    expect(Date.parse(projected.resolutionDueAt)).toBeGreaterThan(Date.parse(base.resolutionDueAt))
  })

  it('reopens a resolved ticket instead of preserving a terminal met state', () => {
    const base = createSupportSlaProjection('urgent', new Date('2026-09-01T09:00:00.000Z'))
    const projected = projectSupportSlaFromEvents(base, [
      { eventType: 'status_changed', payload: { to: 'resolved' }, createdAt: '2026-09-01T10:00:00.000Z' },
      { eventType: 'status_changed', payload: { to: 'open' }, createdAt: '2026-09-01T10:30:00.000Z' },
    ], new Date('2026-09-01T10:30:00.000Z'))

    expect(projected.resolvedAt).toBeUndefined()
    expect(projected.state).toBe('on_track')
  })

  it('allows a reopened ticket to resolve again from the rebuilt event stream', () => {
    const base = createSupportSlaProjection('urgent', new Date('2026-08-31T09:00:00.000Z'))
    const projected = projectSupportSlaFromEvents(base, [
      { eventType: 'status_changed', payload: { to: 'resolved' }, createdAt: '2026-08-31T12:00:00.000Z' },
      { eventType: 'status_changed', payload: { to: 'in_progress' }, createdAt: '2026-09-01T09:00:00.000Z' },
      { eventType: 'status_changed', payload: { to: 'closed' }, createdAt: '2026-09-01T10:00:00.000Z' },
    ], new Date('2026-09-01T10:00:00.000Z'))

    expect(projected.resolvedAt).toBe('2026-09-01T10:00:00.000Z')
    expect(projected.state).toBe('met')
  })

  it('schedules the cutoff on the third UTC business day, skipping weekends', () => {
    expect(supportSlaReportCutoffAt('2026-09-01T00:00:00.000Z')).toBe('2026-09-03T00:00:00.000Z')
    expect(supportSlaReportCutoffAt('2026-10-01T00:00:00.000Z')).toBe('2026-10-05T00:00:00.000Z')
    expect(() => supportSlaReportCutoffAt('2026-09-01')).toThrow('SUPPORT_SLA_REPORT_PERIOD_END_INVALID')
  })
})
