import { describe, expect, it } from 'vitest'
import { buildCanonicalIdentityHash, resolveOnboardingImportWindow } from './onboarding.js'

describe('onboarding import domain rules', () => {
  it('opens from configuring and closes at the earlier accepted or paid+60d deadline', () => {
    const result = resolveOnboardingImportWindow({
      state: 'configuring', configuringAt: '2026-01-01T00:00:00.000Z', paidAt: '2026-01-02T00:00:00.000Z',
      acceptedAt: '2026-02-15T00:00:00.000Z', now: '2026-02-10T00:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: true, value: { status: 'open', endsAt: '2026-02-15T00:00:00.000Z' } })
  })

  it('does not let acceptance extend the paid 60-day deadline', () => {
    const result = resolveOnboardingImportWindow({
      state: 'accepted', configuringAt: '2026-01-01T00:00:00.000Z', paidAt: '2026-01-02T00:00:00.000Z',
      acceptedAt: '2026-04-01T00:00:00.000Z', now: '2026-03-04T00:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: true, value: { status: 'closed', closeReason: 'paid_window_expired', endsAt: '2026-03-03T00:00:00.000Z' } })
  })

  it('keeps rejected orders closed and reports invalid chronology', () => {
    expect(resolveOnboardingImportWindow({ state: 'rejected', configuringAt: '2026-01-02T00:00:00.000Z', paidAt: '2026-01-03T00:00:00.000Z', now: '2026-01-01T00:00:00.000Z' })).toMatchObject({ ok: true, value: { status: 'closed', closeReason: 'rejected' } })
    expect(resolveOnboardingImportWindow({ state: 'configuring', configuringAt: '2026-01-03T00:00:00.000Z', paidAt: '2026-01-02T00:00:00.000Z', now: '2026-01-03T00:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'ONBOARDING_WINDOW_INVALID' } })
  })

  it('normalizes equivalent legal identities to one hash without exposing the identity', () => {
    const first = buildCanonicalIdentityHash({ jurisdiction: 'cn ', registrationType: ' unified credit ', registrationNumber: ' ab 12 ' })
    const second = buildCanonicalIdentityHash({ jurisdiction: 'ＣＮ', registrationType: 'UNIFIED CREDIT', registrationNumber: 'AB 12' })
    expect(first).toMatchObject({ ok: true, value: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(second).toEqual(first)
    expect(first.ok && first.value).not.toContain('AB 12')
  })

  it('rejects empty identity parts instead of creating a shared sentinel key', () => {
    expect(buildCanonicalIdentityHash({ jurisdiction: 'CN', registrationType: 'company', registrationNumber: ' ' })).toMatchObject({ ok: false, error: { code: 'CANONICAL_IDENTITY_INVALID' } })
  })
})
