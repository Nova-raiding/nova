import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { describeApiError, requestMcp, type ApiError, type MerchantAuthAccount } from './api.js'
import './MerchantMembersPage.css'

type MemberRole = 'workspace_owner' | 'merchant_admin' | 'operator' | 'support' | 'finance' | 'platform_ops'
type MemberStatus = 'invited' | 'active' | 'suspended'
type Member = {
  id: string
  externalSubject: string
  displayName: string
  role: MemberRole
  status: MemberStatus
  revision: number
  governance?: { canChangeTarget: boolean; canDeactivateTarget: boolean; reasonCode?: string }
}
type MemberPage = { items: Member[]; total: number; offset: number; limit: number; hasMore: boolean }
type MemberSession = { workspace_id: string | null; workbench: string; capabilities: string[]; assignable_roles: MemberRole[] }
type PendingInvitation = { workspace_id: string; role: MemberRole; revision: number }
type Action = { kind: 'role' | 'suspend' | 'reactivate'; member: Member } | null

const roleLabels: Record<MemberRole, string> = {
  workspace_owner: '工作区所有者', merchant_admin: '企业管理员', operator: '运营', support: '支持', finance: '财务', platform_ops: '平台运营',
}
const statusLabels: Record<MemberStatus, string> = { invited: '待接受', active: '已激活', suspended: '已停用' }
const pageSize = 20

export class MemberRequestGate {
  private generation = 0
  private workspaceId = ''
  begin(workspaceId: string) { this.workspaceId = workspaceId; return { workspaceId, generation: ++this.generation } }
  invalidate(workspaceId = '') { this.workspaceId = workspaceId; this.generation++ }
  isCurrent(token: { workspaceId: string; generation: number }) { return token.workspaceId === this.workspaceId && token.generation === this.generation }
}

export function memberSessionScope(session: MemberSession, account: MerchantAuthAccount, selectedWorkspaceId: string) {
  const workspaceId = session.workspace_id?.trim()
  return session.workbench === 'workspace' && Boolean(workspaceId && workspaceId === selectedWorkspaceId && account.workspaceIds.includes(workspaceId))
    ? workspaceId!
    : null
}

export function memberActions(session: MemberSession, member: Member) {
  const canManage = session.capabilities.includes('workspace.member.manage')
  const change = canManage && member.governance?.canChangeTarget === true
  return {
    changeRole: change,
    suspend: change && member.status !== 'suspended' && member.governance?.canDeactivateTarget === true,
    reactivate: change && member.status === 'suspended',
  }
}

export function preferredInviteRole(session: MemberSession, current?: MemberRole): MemberRole | null {
  const roles = (session.assignable_roles ?? []).filter((role) => role !== 'platform_ops' && Object.hasOwn(roleLabels, role))
  return current && roles.includes(current) ? current : roles.includes('operator') ? 'operator' : roles[0] ?? null
}

export function MerchantMembersPage({ baseUrl, account, activeWorkspaceId, onWorkspaceChange }: { baseUrl: string; account: MerchantAuthAccount; activeWorkspaceId?: string | null; onWorkspaceChange?: (workspaceId: string) => void }) {
  const [localWorkspaceId, setLocalWorkspaceId] = useState(account.workspaceIds.length === 1 ? account.workspaceIds[0] ?? '' : '')
  const selectedWorkspaceId = activeWorkspaceId ?? localWorkspaceId
  const selectedWorkspaceRef = useRef(selectedWorkspaceId)
  // Keep mutations scoped to the currently selected workspace when the parent
  // workbench changes it. This ref is also read by async handlers that can
  // outlive the render that created them.
  selectedWorkspaceRef.current = selectedWorkspaceId
  const requestGate = useRef(new MemberRequestGate())
  const [invitation, setInvitation] = useState<PendingInvitation | null>(null)
  const [session, setSession] = useState<MemberSession | null>(null)
  const [page, setPage] = useState<MemberPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorWorkspaceId, setErrorWorkspaceId] = useState(selectedWorkspaceId)
  const [mutationError, setMutationError] = useState<{ workspaceId: string; message: string } | null>(null)
  const [action, setAction] = useState<Action>(null)
  const [reason, setReason] = useState('')
  const [nextRole, setNextRole] = useState<MemberRole>('operator')
  const [subject, setSubject] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [inviteRole, setInviteRole] = useState<MemberRole | null>(null)
  const [inviteReason, setInviteReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeWorkspaceId, setNoticeWorkspaceId] = useState(selectedWorkspaceId)

  const load = useCallback(async (offset = 0) => {
    const token = requestGate.current.begin(selectedWorkspaceId)
    setLoading(true)
    setInvitation(null)
    setError('')
    setErrorWorkspaceId(selectedWorkspaceId)
    try {
      if (!selectedWorkspaceId || !account.workspaceIds.includes(selectedWorkspaceId)) throw new Error('请选择当前账号已绑定的工作区。')
      const currentSession = await requestMcp<MemberSession>(baseUrl, 'ops.session', {}, selectedWorkspaceId)
      if (!requestGate.current.isCurrent(token)) return
      setSession(currentSession)
      setInviteRole((current) => preferredInviteRole(currentSession, current ?? undefined))
      if (!memberSessionScope(currentSession, account, selectedWorkspaceId)) {
        setPage(null)
        setError('当前登录会话没有可验证的商家工作区范围，请重新登录后重试。')
        setErrorWorkspaceId(selectedWorkspaceId)
        return
      }
      if (!currentSession.capabilities.includes('workspace.member.read')) {
        setPage(null)
        setError('当前账号没有查看工作区成员的权限。')
        setErrorWorkspaceId(selectedWorkspaceId)
        return
      }
      const result = await requestMcp<MemberPage>(baseUrl, 'ops.members.list', { limit: String(pageSize), offset: String(offset) }, selectedWorkspaceId)
      if (!requestGate.current.isCurrent(token)) return
      if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0 || result.offset !== offset) throw new Error('成员列表响应无效，请重试。')
      setPage(result)
    } catch (cause) {
      if (!requestGate.current.isCurrent(token)) return
      setPage(null)
      let failure = cause
      if ((cause as ApiError | undefined)?.code === 'MCP_OAUTH_WORKSPACE_AMBIGUOUS') {
        try {
          const pending = await requestMcp<{ invitations: PendingInvitation[] }>(baseUrl, 'workspace.invitations.list', {}, selectedWorkspaceId)
          if (!requestGate.current.isCurrent(token)) return
          const item = Array.isArray(pending?.invitations) ? pending.invitations.find(item => item.workspace_id === selectedWorkspaceId && Number.isSafeInteger(item.revision) && item.revision > 0) : undefined
          if (item) { setSession(null); setInvitation(item); return }
        } catch (invitationFailure) { failure = invitationFailure }
      }
      setError(`成员列表读取失败：${describeApiError(failure)}`)
      setErrorWorkspaceId(selectedWorkspaceId)
    } finally {
      if (requestGate.current.isCurrent(token)) setLoading(false)
    }
  }, [account, baseUrl, selectedWorkspaceId])

  useEffect(() => {
    // A workspace switch starts a new member context. Drop the prior page and
    // any invite draft so stale data or a partially completed invitation can
    // never look like it belongs to the newly selected workspace.
    requestGate.current.invalidate(selectedWorkspaceId)
    setSession(null)
    setInvitation(null)
    setPage(null)
    setError('')
    setErrorWorkspaceId(selectedWorkspaceId)
    setAction(null)
    setMutationError(null)
    setNotice('')
    setNoticeWorkspaceId(selectedWorkspaceId)
    setSubject('')
    setDisplayName('')
    setInviteReason('')
    setInviteRole(null)
    void load()
    return () => requestGate.current.invalidate()
  }, [load, selectedWorkspaceId])
  const workspaceId = session ? memberSessionScope(session, account, selectedWorkspaceId) : null
  // During the render immediately following a parent workspace switch, the
  // reset effect has not run yet. Never show the previous workspace's rows or
  // actions while the old session no longer matches the selected workspace.
  const visiblePage = workspaceId ? page : null
  const visibleAction = workspaceId ? action : null
  const visibleInvitation = invitation?.workspace_id === selectedWorkspaceId ? invitation : null
  const visibleError = [
    mutationError?.workspaceId === selectedWorkspaceId ? mutationError.message : '',
    errorWorkspaceId === selectedWorkspaceId ? error : '',
  ].filter(Boolean).join('；')
  const visibleNotice = noticeWorkspaceId === selectedWorkspaceId ? notice : ''
  const assignableRoles = (session?.assignable_roles ?? []).filter((role) => role !== 'platform_ops' && Object.hasOwn(roleLabels, role))
  const canManage = Boolean(workspaceId && visiblePage && session?.capabilities.includes('workspace.member.read') && session?.capabilities.includes('workspace.member.manage') && assignableRoles.length)

  const runMutation = async (method: string, params: Record<string, unknown>, success: string) => {
    const targetWorkspaceId = selectedWorkspaceRef.current
    if (!targetWorkspaceId || !account.workspaceIds.includes(targetWorkspaceId)) return
    setSaving(true)
    setMutationError(null)
    setError('')
    setErrorWorkspaceId(targetWorkspaceId)
    setNotice('')
    setNoticeWorkspaceId(targetWorkspaceId)
    try {
      // The backend resolves the target workspace from the authenticated bearer.
      // No browser-supplied workspace ID is accepted for a member mutation.
      await requestMcp(baseUrl, method, params, targetWorkspaceId)
      if (selectedWorkspaceRef.current !== targetWorkspaceId) return
      setAction(null)
      setReason('')
      setInviteReason('')
      setSubject('')
      setDisplayName('')
      setNotice(success)
      setNoticeWorkspaceId(targetWorkspaceId)
      await load(page?.offset ?? 0)
    } catch (cause) {
      if (selectedWorkspaceRef.current === targetWorkspaceId) {
        const status = (cause as ApiError | undefined)?.status
        const uncertain = !status || status >= 500 || status === 408
        setMutationError({ workspaceId: targetWorkspaceId, message: uncertain
          ? `成员操作未确认完成：${describeApiError(cause, { operation: 'write' })}。已保留输入，请先刷新并核对目标成员的角色与状态，避免重复提交。`
          : `成员操作失败：${describeApiError(cause, { operation: 'write' })}。已保留输入，请刷新成员列表后重试。` })
      }
    } finally {
      setSaving(false)
    }
  }

  const acceptInvitation = async () => {
    if (!visibleInvitation || saving || loading) return
    const token = requestGate.current.begin(selectedWorkspaceId)
    setSaving(true)
    setMutationError(null)
    try {
      await requestMcp(baseUrl, 'workspace.invitation.accept', { expected_revision: String(visibleInvitation.revision), reason: '用户在商家工作台接受工作区邀请' }, selectedWorkspaceId)
      if (!requestGate.current.isCurrent(token)) return
      setInvitation(null)
      setNotice('已接受工作区邀请。')
      setNoticeWorkspaceId(selectedWorkspaceId)
      await load()
    } catch (cause) {
      if (requestGate.current.isCurrent(token)) {
        // A failed or lost response invalidates this displayed invitation.
        // Require an explicit read before another acceptance attempt.
        setInvitation(null)
        const status = (cause as ApiError | undefined)?.status
        const prefix = status && status >= 400 && status < 500 && status !== 408 ? '接受邀请失败' : '接受邀请未确认完成'
        setMutationError({ workspaceId: selectedWorkspaceId, message: `${prefix}：${describeApiError(cause, { operation: 'write' })}。请刷新核对邀请状态。` })
      }
    } finally { if (selectedWorkspaceRef.current === token.workspaceId) setSaving(false) }
  }

  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = subject.trim()
    if (!canManage || !normalized || inviteReason.trim().length < 4 || !inviteRole || !assignableRoles.includes(inviteRole)) return
    void runMutation('ops.member.upsert', { external_subject: normalized, display_name: displayName.trim(), role: inviteRole, status: 'invited', reason: inviteReason.trim() }, `已邀请 ${displayName.trim() || normalized}。`)
  }

  const submitAction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage || loading || !session || !action || !memberSessionScope(session, account, selectedWorkspaceRef.current) || reason.trim().length < 4) return
    const allowed = memberActions(session, action.member)
    if (action.kind === 'role' && allowed.changeRole && assignableRoles.includes(nextRole)) {
      void runMutation('ops.member.upsert', { external_subject: action.member.externalSubject, display_name: action.member.displayName, role: nextRole, expected_revision: String(action.member.revision), reason: reason.trim() }, '成员角色已更新。')
    } else if (action.kind === 'suspend' && allowed.suspend) {
      void runMutation('ops.member.suspend', { external_subject: action.member.externalSubject, expected_revision: String(action.member.revision), reason: reason.trim() }, '成员已停用。')
    } else if (action.kind === 'reactivate' && allowed.reactivate) {
      void runMutation('ops.member.upsert', { external_subject: action.member.externalSubject, display_name: action.member.displayName, role: action.member.role, status: 'active', expected_revision: String(action.member.revision), reason: reason.trim() }, '成员已恢复。')
    }
  }

  return <section className="page-stack merchant-members" aria-label="工作区成员管理">
    <header><span className="section-kicker">工作区成员</span><h1>成员与权限</h1><p>查看当前商家工作区成员；邀请与变更由服务端权限和成员治理规则决定，并记录操作原因。</p></header>
    {account.workspaceIds.length > 1 && !onWorkspaceChange && <label>商家工作区 ID <select aria-label="选择商家工作区 ID" value={selectedWorkspaceId} disabled={saving} onChange={(event) => { const next = event.target.value; requestGate.current.invalidate(next); selectedWorkspaceRef.current = next; setSession(null); setPage(null); setAction(null); setError(''); setErrorWorkspaceId(next); setNotice(''); setNoticeWorkspaceId(next); setLoading(true); setLocalWorkspaceId(next) }}>{account.workspaceIds.map((id) => <option key={id} value={id}>工作区 ID · {id}</option>)}</select></label>}
    {workspaceId && <p>当前工作区：<code>{workspaceId}</code></p>}
    {visibleInvitation && <section aria-label="待接受的工作区邀请"><h2>你收到一份工作区邀请</h2><p>工作区：<code>{visibleInvitation.workspace_id}</code></p><p>邀请角色：{roleLabels[visibleInvitation.role] ?? visibleInvitation.role}。接受后才能使用此工作区的对应权限。</p><button type="button" disabled={saving || loading} onClick={() => void acceptInvitation()}>接受工作区邀请</button></section>}
    {visibleNotice && <div role="status" className="success-notice">{visibleNotice}</div>}
    {visibleError && <div role="alert" className="error-notice">{visibleError}</div>}
    <button type="button" onClick={() => void load(visiblePage?.offset ?? 0)} disabled={loading || saving || !selectedWorkspaceId || !account.workspaceIds.includes(selectedWorkspaceId)}>刷新成员列表</button>
    {loading || (!workspaceId && !visibleError && !visibleInvitation) ? <p role="status">{workspaceId ? '正在读取成员列表…' : '正在切换工作区…'}</p> : visiblePage && <>
      <div role="status">共 {visiblePage.total} 位成员</div>
      {visiblePage.items.length === 0 ? <p>当前工作区还没有成员。</p> : <table aria-label="工作区成员列表"><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {visiblePage.items.map((member) => {
          const allowed = session ? memberActions(session, member) : { changeRole: false, suspend: false, reactivate: false }
          const roleLabel = Object.hasOwn(roleLabels, member.role) ? roleLabels[member.role] : member.role
          const statusLabel = Object.hasOwn(statusLabels, member.status) ? statusLabels[member.status] : member.status
          return <tr key={member.id}><td>{member.displayName || member.externalSubject}<small className="muted">{member.displayName ? ` · ${member.externalSubject}` : ''}</small></td><td>{roleLabel}</td><td>{statusLabel}</td><td>
            {allowed.changeRole && <button type="button" aria-label={`调整 ${member.displayName || member.externalSubject} 的角色`} onClick={() => { setAction({ kind: 'role', member }); setNextRole(member.role); setReason('') }}>改角色</button>}
            {allowed.suspend && <button type="button" aria-label={`停用 ${member.displayName || member.externalSubject}`} onClick={() => { setAction({ kind: 'suspend', member }); setReason('') }}>停用</button>}
            {allowed.reactivate && <button type="button" aria-label={`恢复 ${member.displayName || member.externalSubject}`} onClick={() => { setAction({ kind: 'reactivate', member }); setReason('') }}>恢复</button>}
            {!allowed.changeRole && !allowed.suspend && !allowed.reactivate && <span className="muted">仅查看</span>}
          </td></tr>
        })}
      </tbody></table>}
      <div><button type="button" onClick={() => void load(Math.max(0, visiblePage.offset - pageSize))} disabled={visiblePage.offset === 0 || saving}>上一页</button> <button type="button" onClick={() => void load(visiblePage.offset + pageSize)} disabled={!visiblePage.hasMore || saving}>下一页</button></div>
    </>}
    {canManage && <form onSubmit={invite} aria-label="邀请工作区成员"><h2>邀请成员</h2><label>成员登录账号<input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="例如：member@example.com 或平台账号" aria-describedby="merchant-member-invite-account-help" autoComplete="off" required /></label><small id="merchant-member-invite-account-help" className="muted">填写对方登录商家工作台使用的账号；系统会按此账号关联成员记录。</small><label>显示名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label>角色<select value={inviteRole ?? ''} onChange={(event) => setInviteRole(event.target.value as MemberRole)} required><option value="" disabled>请选择角色</option>{assignableRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label><label>邀请原因<input value={inviteReason} onChange={(event) => setInviteReason(event.target.value)} minLength={4} required /></label><button type="submit" disabled={saving || loading || !subject.trim() || !inviteRole || inviteReason.trim().length < 4}>邀请成员</button></form>}
    {visibleAction && <form onSubmit={submitAction} aria-label="成员变更"><h2>{visibleAction.kind === 'role' ? '调整角色' : visibleAction.kind === 'suspend' ? '停用成员' : '恢复成员'} · {visibleAction.member.displayName || visibleAction.member.externalSubject}</h2>{visibleAction.kind === 'role' && <label>新角色<select value={nextRole} onChange={(event) => setNextRole(event.target.value as MemberRole)}>{assignableRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label>}<label>操作原因<input value={reason} onChange={(event) => setReason(event.target.value)} minLength={4} required /></label><button type="button" onClick={() => setAction(null)}>取消</button><button type="submit" disabled={saving || loading || !canManage || reason.trim().length < 4}>确认{visibleAction.kind === 'role' ? '改角色' : visibleAction.kind === 'suspend' ? '停用' : '恢复'}</button></form>}
  </section>
}
