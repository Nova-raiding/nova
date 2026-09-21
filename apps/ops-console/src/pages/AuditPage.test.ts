import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { auditPageScope } from './AuditPage.js'
import type { OpsConsoleModel } from '../hooks/useOpsConsoleModel.js'

const model = (input: { platform: boolean; target?: string; exportable?: boolean }) => ({
  authorization: {
    scope: { kind: input.platform ? 'platform' : 'workspace' },
    can: vi.fn((capability: string) => capability === 'audit.export' && input.exportable === true),
  },
  authorizationTargetWorkspaceId: input.target ?? '',
  opsWorkspaceId: 'session-workspace',
}) as unknown as OpsConsoleModel

describe('AuditPage', () => {
  it('uses the canonical audit client through the real hook and registry model', async () => {
    const source = await readFile(new URL('./AuditPage.tsx', import.meta.url), 'utf8')
    expect(source).toContain('useAuditCenter(auditCenterClient, workspaceId, true, platformScope)')
    expect(source).not.toContain('sessionRoles')
    expect(source).not.toContain('model.auditCenterClient')
    expect(source).not.toContain('AuditTrailSection')
  })

  it('keeps the unselected platform view aggregate and non-exportable', () => {
    expect(auditPageScope(model({ platform: true, exportable: true }))).toEqual({
      platformScope: true,
      workspaceId: 'session-workspace',
      canExport: false,
    })
  })

  it('uses the explicit platform target for tenant detail and export', () => {
    expect(auditPageScope(model({ platform: true, target: ' ws-selected ', exportable: true }))).toEqual({
      platformScope: false,
      workspaceId: 'ws-selected',
      canExport: true,
    })
  })

  it('never lets a stale platform target override a workspace-scoped session', () => {
    expect(auditPageScope(model({ platform: false, target: 'ws-stale', exportable: true }))).toEqual({
      platformScope: false,
      workspaceId: 'session-workspace',
      canExport: true,
    })
  })
})
