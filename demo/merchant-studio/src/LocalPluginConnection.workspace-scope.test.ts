import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('local plugin workspace context', () => {
  it('keys connection guidance to the global active workspace and only accepts the account origin', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(component).toContain('const scope = JSON.stringify([apiBaseUrl, account.id, account.login, account.status, account.workspaceIds, activeWorkspaceId])')
    expect(component).toContain('open={openScope === scope}')
    expect(component).toContain('onWorkspaceChange(id)')
    expect(component).toContain('pairingMatchesWorkspace(pairing, workspaceId)')
    expect(component).toContain('/^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u')
    expect(component).toContain("base.protocol === 'http:' && base.hostname === '127.0.0.1'")
    expect(component).toContain('base.username || base.password')
    expect(component).toContain('shellSafeOrigin.test(base.origin)')
    expect(component).not.toContain('<API_ORIGIN>')
  })
})
