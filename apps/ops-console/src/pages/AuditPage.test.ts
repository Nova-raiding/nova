import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('AuditPage', () => {
  it('uses the canonical audit client through the real hook and registry model', async () => {
    const source = await readFile(new URL('./AuditPage.tsx', import.meta.url), 'utf8')
    expect(source).toContain('useAuditCenter(auditCenterClient, model.opsWorkspaceId, true, platformScope)')
    expect(source).toContain("model.authorization.can('audit.export')")
    expect(source).not.toContain('sessionRoles')
    expect(source).not.toContain('model.auditCenterClient')
    expect(source).not.toContain('AuditTrailSection')
  })
})
