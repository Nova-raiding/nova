import { describe, expect, it } from 'vitest'
import { resolveLibraryData } from './library-data'
import { resolveTaskDirections, resolveTaskWorkflow } from './task-evidence'

describe('unconfigured workspaces never fabricate business evidence', () => {
  it('shows no rules or categories when no service is configured, including stale remote and fixture inputs', () => {
    const state = resolveLibraryData({ baseUrl: undefined, remote: [{ id: 'stale-rule' }], error: '', fixtures: [{ id: 'fake-rule' }] })
    expect(state).toEqual({ mode: 'unconfigured', items: [] })
  })
  it('shows no creative direction without a configured service', () => {
    expect(resolveTaskDirections({ baseUrl: undefined, remote: null, error: '' })).toEqual({ mode: 'unconfigured', items: [] })
  })
  it('marks every step unconfirmed without a service, even when a cached state says approved', () => {
    expect(resolveTaskWorkflow('approved', true).map(step => step.status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })
  it('maps accepted legacy generated content to the review stage', () => {
    expect(resolveTaskWorkflow('content_generated').map(step => step.status)).toEqual(['complete', 'complete', 'current', 'pending'])
  })
})
