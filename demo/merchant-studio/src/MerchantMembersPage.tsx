import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { describeApiError, requestMcp, type MerchantAuthAccount } from './api.js'
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

export function MerchantMembersPage({ baseUrl, account }: { baseUrl: string; account: MerchantAuthAccount }) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(account.workspaceIds[0] ?? '')
  const selectedWorkspaceRef = useRef(selectedWorkspaceId)
  const requestGate = useRef(new MemberRequestGate())
  const [session, setSession] = useState<MemberSession | null>(null)
  const [page, setPage] = useState<MemberPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [action, setAction] = useState<Action>(null)
  const [reason, setReason] = useState('')
  const [nextRole, setNextRole] = useState<MemberRole>('operator')
  const [subject, setSubject] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [inviteRole, setInviteRole] = useState<MemberRole>('operator')
  const [inviteReason, setInviteReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async (offset = 0) => {
    const token = requestGate.current.begin(selectedWorkspaceId)
    setLoading(true)
    setError('')
    try {
      if (!selectedWorkspaceId || !account.workspaceIds.includes(selectedWorkspaceId)) throw new Error('请选择当前账号已绑定的工作区。')
      const currentSession = await requestMcp<MemberSession>(baseUrl, 'ops.session', {}, selectedWorkspaceId)
      if (!requestGate.current.isCurrent(token)) return
      setSession(currentSession)
      if (!memberSessionScope(currentSession, account, selectedWorkspaceId)) {
        setPage(null)
        setError('当前登录会话没有可验证的商家工作区范围，请重新登录后重试。')
        return
      }
      if (!currentSession.capabilities.includes('workspace.member.read')) {
        setPage(null)
        setError('当前账号没有查看工作区成员的权限。')
        return
      }
      const result = await requestMcp<MemberPage>(baseUrl, 'ops.members.list', { limit: String(pageSize), offset: String(offset) }, selectedWorkspaceId)
      if (!requestGate.current.isCurrent(token)) return
      if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0 || result.offset !== offset) throw new Error('成员列表响应无效，请重试。')
      setPage(result)
    } catch (cause) {
      if (!requestGate.current.isCurrent(token)) return
      setPage(null)
      setError(`成员列表读取失败：${describeApiError(cause)}`)
    } finally {
      if (requestGate.current.isCurrent(token)) setLoading(false)
    }
  }, [account, baseUrl, selectedWorkspaceId])

  useEffect(() => { void load(); return () => requestGate.current.invalidate() }, [load])
  const workspaceId = session ? memberSessionScope(session, account, selectedWorkspaceId) : null
  const assignableRoles = (session?.assignable_roles ?? []).filter((role) => role !== 'platform_ops' && role in roleLabels)
  const canManage = Boolean(workspaceId && page && session?.capabilities.includes('workspace.member.read') && session?.capabilities.includes('workspace.member.manage') && assignableRoles.length)

  const runMutation = async (method: string, params: Record<string, unknown>, success: string) => {
    const targetWorkspaceId = selectedWorkspaceRef.current
    if (!targetWorkspaceId || !account.workspaceIds.includes(targetWorkspaceId)) return
    setSaving(true)
    setError('')
    setNotice('')
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
      await load(page?.offset ?? 0)
    } catch (cause) {
      if (selectedWorkspaceRef.current === targetWorkspaceId) setError(`成员操作失败：${describeApiError(cause)}。已保留输入，请刷新成员列表后重试。`)
    } finally {
      setSaving(false)
    }
  }

  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = subject.trim()
    if (!canManage || !normalized || inviteReason.trim().length < 4 || !assignableRoles.includes(inviteRole)) return
    void runMutation('ops.member.upsert', { external_subject: normalized, display_name: displayName.trim(), role: inviteRole, status: 'invited', reason: inviteReason.trim() }, `已邀请 ${displayName.trim() || normalized}。`)
  }

  const submitAction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!session || !action || !memberSessionScope(session, account, selectedWorkspaceRef.current) || reason.trim().length < 4) return
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
    {account.workspaceIds.length > 1 && <label>商家工作区 <select aria-label="选择商家工作区" value={selectedWorkspaceId} disabled={saving} onChange={(event) => { const next = event.target.value; requestGate.current.invalidate(next); selectedWorkspaceRef.current = next; setSession(null); setPage(null); setAction(null); setError(''); setLoading(true); setSelectedWorkspaceId(next) }}>{account.workspaceIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>}
    {workspaceId && <p>当前工作区：<code>{workspaceId}</code></p>}
    {notice && <div role="status" className="success-notice">{notice}</div>}
    {error && <div role="alert" className="error-notice">{error}</div>}
    <button type="button" onClick={() => void load(page?.offset ?? 0)} disabled={loading || saving}>刷新成员列表</button>
    {loading ? <p role="status">正在读取成员列表…</p> : page && <>
      <div role="status">共 {page.total} 位成员</div>
      {page.items.length === 0 ? <p>当前工作区还没有成员。</p> : <table aria-label="工作区成员列表"><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {page.items.map((member) => {
          const allowed = session ? memberActions(session, member) : { changeRole: false, suspend: false, reactivate: false }
          return <tr key={member.id}><td>{member.displayName || member.externalSubject}<small className="muted">{member.displayName ? ` · ${member.externalSubject}` : ''}</small></td><td>{roleLabels[member.role] ?? member.role}</td><td>{statusLabels[member.status] ?? member.status}</td><td>
            {allowed.changeRole && <button type="button" onClick={() => { setAction({ kind: 'role', member }); setNextRole(member.role); setReason('') }}>改角色</button>}
            {allowed.suspend && <button type="button" onClick={() => { setAction({ kind: 'suspend', member }); setReason('') }}>停用</button>}
            {allowed.reactivate && <button type="button" onClick={() => { setAction({ kind: 'reactivate', member }); setReason('') }}>恢复</button>}
            {!allowed.changeRole && !allowed.suspend && !allowed.reactivate && <span className="muted">仅查看</span>}
          </td></tr>
        })}
      </tbody></table>}
      <div><button type="button" onClick={() => void load(Math.max(0, page.offset - pageSize))} disabled={page.offset === 0 || saving}>上一页</button> <button type="button" onClick={() => void load(page.offset + pageSize)} disabled={!page.hasMore || saving}>下一页</button></div>
    </>}
    {canManage && <form onSubmit={invite} aria-label="邀请工作区成员"><h2>邀请成员</h2><label>用户 ID<input value={subject} onChange={(event) => setSubject(event.target.value)} required /></label><label>显示名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label>角色<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as MemberRole)}>{assignableRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label><label>邀请原因<input value={inviteReason} onChange={(event) => setInviteReason(event.target.value)} minLength={4} required /></label><button type="submit" disabled={saving || loading || !subject.trim() || inviteReason.trim().length < 4}>邀请成员</button></form>}
    {action && <form onSubmit={submitAction} aria-label="成员变更"><h2>{action.kind === 'role' ? '调整角色' : action.kind === 'suspend' ? '停用成员' : '恢复成员'} · {action.member.displayName || action.member.externalSubject}</h2>{action.kind === 'role' && <label>新角色<select value={nextRole} onChange={(event) => setNextRole(event.target.value as MemberRole)}>{assignableRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label>}<label>操作原因<input value={reason} onChange={(event) => setReason(event.target.value)} minLength={4} required /></label><button type="button" onClick={() => setAction(null)}>取消</button><button type="submit" disabled={saving || reason.trim().length < 4}>确认{action.kind === 'role' ? '改角色' : action.kind === 'suspend' ? '停用' : '恢复'}</button></form>}
  </section>
}
