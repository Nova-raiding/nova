import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MerchantAuthAccount } from './api.js'
import { MemberRequestGate, memberActions, memberSessionScope } from './MerchantMembersPage.js'
import { merchantRouteFromLocation, urlForMerchantRoute } from './navigation.js'

const membersPageSource = readFileSync(resolve(import.meta.dirname, 'MerchantMembersPage.tsx'), 'utf8')

const account = { accountType: 'merchant', workspaceIds: ['ws_a', 'ws_b'] } as MerchantAuthAccount
const session = { workspace_id: 'ws_a', workbench: 'workspace', capabilities: ['workspace.member.read', 'workspace.member.manage'], assignable_roles: ['operator'] }
const member = { id: 'member_1', externalSubject: 'member@example.com', displayName: 'Member', role: 'operator', status: 'active', revision: 2 }

describe('merchant members scope and governance', () => {
  it('requires the server session workspace to match the selected account workspace', () => {
    expect(memberSessionScope(session, account, 'ws_a')).toBe('ws_a')
    expect(memberSessionScope(session, account, 'ws_b')).toBeNull()
    expect(memberSessionScope({ ...session, workbench: 'platform' }, account, 'ws_a')).toBeNull()
    expect(memberSessionScope({ ...session, workspace_id: 'ws_foreign' }, account, 'ws_foreign')).toBeNull()
  })

  it('does not manufacture member actions without both server capability and target governance', () => {
    expect(memberActions(session, member)).toEqual({ changeRole: false, suspend: false, reactivate: false })
    expect(memberActions({ ...session, capabilities: ['workspace.member.read'] }, { ...member, governance: { canChangeTarget: true, canDeactivateTarget: true } })).toEqual({ changeRole: false, suspend: false, reactivate: false })
    expect(memberActions(session, { ...member, governance: { canChangeTarget: true, canDeactivateTarget: false } })).toEqual({ changeRole: true, suspend: false, reactivate: false })
    expect(memberActions(session, { ...member, status: 'suspended', governance: { canChangeTarget: true, canDeactivateTarget: false } })).toEqual({ changeRole: true, suspend: false, reactivate: true })
  })

  it('keeps the rendered member list behind server read capability and workspace scope', () => {
    const scopeCheck = membersPageSource.indexOf('if (!memberSessionScope(currentSession, account, selectedWorkspaceId))')
    const readCapabilityCheck = membersPageSource.indexOf("if (!currentSession.capabilities.includes('workspace.member.read'))")
    const listRequest = membersPageSource.indexOf("'ops.members.list'")
    expect(scopeCheck).toBeGreaterThan(-1)
    expect(readCapabilityCheck).toBeGreaterThan(scopeCheck)
    expect(listRequest).toBeGreaterThan(readCapabilityCheck)
    expect(membersPageSource).toContain("const canManage = Boolean(workspaceId && page && session?.capabilities.includes('workspace.member.read') && session?.capabilities.includes('workspace.member.manage')")
  })

  it('keeps the member destination stable across direct links and in-app navigation', () => {
    expect(merchantRouteFromLocation({ pathname: '/merchant/members', search: '', hash: '' }).page).toBe('members')
    expect(urlForMerchantRoute({ pathname: '/merchant/finance', search: '' }, { page: 'members' })).toBe('/merchant/members')
  })

  it('rejects an older workspace response after selection or a newer request', () => {
    const gate = new MemberRequestGate()
    const first = gate.begin('ws_a')
    gate.invalidate('ws_b')
    const second = gate.begin('ws_b')
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
    const refreshed = gate.begin('ws_b')
    expect(gate.isCurrent(second)).toBe(false)
    expect(gate.isCurrent(refreshed)).toBe(true)
    gate.invalidate()
    expect(gate.isCurrent(refreshed)).toBe(false)
  })

  it('clears the previous workspace success notice when switching workspaces', () => {
    const switchHandler = membersPageSource.match(/onChange=\{\(event\) => \{ const next = event\.target\.value;([\s\S]*?)setSelectedWorkspaceId\(next\) \}\}/)?.[1] ?? ''
    expect(switchHandler).toContain("setNotice('')")
    expect(switchHandler).toContain('setPage(null)')
  })
})
