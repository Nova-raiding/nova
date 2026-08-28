import { describe, expect, it } from 'vitest'
import { domainFromLocation, urlForDomain } from '../apps/ops-console/src/navigation/opsNavigation.js'

describe('ops console page routing', () => {
  it('restores every page from its URL path', () => {
    expect(domainFromLocation({ pathname: '/ops/overview', hash: '' })).toBe('overview')
    expect(domainFromLocation({ pathname: '/ops/tasks', hash: '' })).toBe('tasks')
    expect(domainFromLocation({ pathname: '/ops/stores', hash: '' })).toBe('stores')
    expect(domainFromLocation({ pathname: '/ops/finance', hash: '' })).toBe('finance')
  })

  it('keeps legacy routes and hash bookmarks compatible', () => {
    expect(domainFromLocation({ pathname: '/ops/governance', hash: '' })).toBe('overview')
    expect(domainFromLocation({ pathname: '/', hash: '#stores' })).toBe('stores')
    expect(domainFromLocation({ pathname: '/unknown', hash: '#unknown' })).toBe('overview')
  })

  it('builds independent page URLs and preserves query parameters', () => {
    expect(urlForDomain({ pathname: '/ops/tasks', search: '?workspace=demo' }, 'finance')).toBe('/ops/finance?workspace=demo')
    expect(urlForDomain({ pathname: '/console/', search: '' }, 'stores')).toBe('/console/ops/stores')
  })
})
