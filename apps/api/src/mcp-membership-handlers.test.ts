import { describe, expect, it, vi } from 'vitest'
import { MemoryMembersRepository } from '../../../packages/persistence/src/members-repository.js'
import { acceptWorkspaceInvitation, listOpsMembers, listWorkspaceInvitations } from './mcp-membership-handlers.js'

describe('workspace invitation MCP handlers', () => {
  it('accepts an invitation addressed to the authenticated subject when the login differs', async () => {
    const members = new MemoryMembersRepository()
    const workspaceId = 'ws_invitation_subject'
    const subject = 'identity_subject_123'
    const invited = await members.upsert({ workspaceId, externalSubject: subject, displayName: '受邀商家', role: 'operator', status: 'invited', invitedBy: 'owner_123' })
    const subjects = new Set([subject, 'merchant@example.test'])

    expect(await listWorkspaceInvitations({ workspaceId, subjects, members })).toMatchObject({ unread_count: 1, invitations: [{ member_id: invited.id, revision: invited.revision }] })

    const accepted = await acceptWorkspaceInvitation({ workspaceId, actorId: 'merchant@example.test', subjects, params: { expected_revision: String(invited.revision) }, members, expectedRevision: params => Number(params.expected_revision) })
    expect(accepted.member).toMatchObject({ externalSubject: subject, status: 'active', revision: invited.revision + 1 })
    expect(await listWorkspaceInvitations({ workspaceId, subjects, members })).toMatchObject({ unread_count: 0, invitations: [] })
  })

  it('refuses an invitation addressed to another subject', async () => {
    const members = new MemoryMembersRepository()
    const workspaceId = 'ws_invitation_other'
    await members.upsert({ workspaceId, externalSubject: 'other_subject', displayName: '其他人', role: 'operator', status: 'invited', invitedBy: 'owner_123' })
    await expect(acceptWorkspaceInvitation({ workspaceId, actorId: 'merchant@example.test', subjects: new Set(['merchant@example.test']), params: { expected_revision: '1' }, members, expectedRevision: params => Number(params.expected_revision) })).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' })
  })
})

describe('ops member pagination input', () => {
  it.each([
    ['limit', 'many'], ['limit', true], ['limit', '1.5'],
    ['offset', 'first'], ['offset', false], ['offset', '-1'],
  ])('rejects malformed %s instead of silently using the default page', async (key, value) => {
    const list = vi.fn(async () => [])
    await expect(listOpsMembers({
      workspaceId: 'ws_members_page', params: { [key as string]: value },
      members: { list } as never, platformOperator: false,
      authorization: { capabilities: [], roles: [], canonicalRoles: [], scopes: [], atoms: [] } as never,
      actorSubjects: new Set(),
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(list).not.toHaveBeenCalled()
  })
})
