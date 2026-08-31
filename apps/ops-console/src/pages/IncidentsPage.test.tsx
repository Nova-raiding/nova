import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { IncidentsClient } from '../hooks/useIncidents.js'
import { IncidentsPage } from './IncidentsPage.js'
import { createAuthorizationProjection } from '../authz/authorization.js'

const client: IncidentsClient = {
  list: async () => ({ items: [] }), timeline: async () => ({ items: [] }),
  create: async () => { throw new Error('unused') }, comment: async () => { throw new Error('unused') },
  transition: async () => { throw new Error('unused') }, assignCommander: async () => { throw new Error('unused') }, updateScope: async () => { throw new Error('unused') },
}

describe('IncidentsPage', () => {
  it('keeps support users read/comment only', () => {
    const authorization = createAuthorizationProjection({ actor_id: 'support', workspace_id: 'ws_1', roles: [], workspace_granted: true, capabilities: ['incident.read'] }, true)
    const html = renderToStaticMarkup(<IncidentsPage client={client} authorization={authorization} />)
    expect(html).toContain('事故中心')
    expect(html).not.toContain('创建事故')
    expect(html).toContain('aria-busy="true"')
  })

  it('exposes create action to platform operations', () => {
    const authorization = createAuthorizationProjection({ actor_id: 'ops', workspace_id: 'ws_1', roles: [], workspace_granted: true, capabilities: ['incident.read', 'incident.update'], scope: { type: 'platform' } }, true)
    const html = renderToStaticMarkup(<IncidentsPage client={client} authorization={authorization} />)
    expect(html).toContain('创建事故')
  })
})
