import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { compareMembersByRecency, DEFAULT_MEMBER_ENTERPRISE_NAME, memberIdentityKey, memberMatchesQuery, type MembersRepository, type MemberStatus, type OperationsRepository, type WorkspaceMember } from '../../../packages/persistence/src/index.js'
import type { PasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import type { IdentityLifecycleRepository, IdentityOperationsDetail } from '../../../packages/persistence/src/identity-lifecycle-repository.js'
import { redactAuditEvidence, redactAuditReason } from '../../../packages/persistence/src/audit-center-repository.js'
import { mapWithConcurrency } from './bounded-concurrency.js'
import { csvCell } from './ops/csv-cell.js'

type CommercialSummary = {
  planCode: string
  planName: string
  subscriptionStatus: string
  usedTasks: number
  includedTasks: number
  remainingTasks: number
  walletBalanceCny: string
}

type Dependencies = {
  requirePlatformReadRole: (req: IncomingMessage) => unknown
  listWorkspaceIds?: () => Promise<string[]>
  knownWorkspaces: ReadonlySet<string>
  members?: MembersRepository
  memoryMembers: MembersRepository
  identities?: IdentityLifecycleRepository
  memoryIdentities: IdentityLifecycleRepository
  operations?: OperationsRepository
  memoryOperations: OperationsRepository
  passwordAuthRepository: PasswordAuthRepository
  loadPlatformWorkspaceEnterpriseNames: (workspaceIds: readonly string[]) => Promise<Map<string, string>>
  loadPlatformUserCommercialSummaries: (workspaceIds: readonly string[]) => Promise<Map<string, CommercialSummary>>
  getWorkspaceStatus: (workspaceId: string) => Promise<'active' | 'disabled'>
  boundOpsUserWorkspaceScan: (workspaceIds: readonly string[]) => { workspaceIds: readonly string[]; scanTruncated: boolean }
  mapIdentityLifecycleError: (error: unknown) => never
}

export const MCP_OPS_USERS_METHODS = new Set(['ops.users.list', 'ops.users.export', 'ops.user.detail'])

/** Returns the unwrapped MCP result; the transport remains in server.ts. */
export async function handleMcpOpsUsersMethod(method: string, params: Record<string, unknown>, req: IncomingMessage, dependencies: Dependencies): Promise<unknown> {
  const {
    requirePlatformReadRole, knownWorkspaces, memoryMembers, memoryIdentities,
    memoryOperations, passwordAuthRepository, loadPlatformWorkspaceEnterpriseNames,
    loadPlatformUserCommercialSummaries, getWorkspaceStatus, boundOpsUserWorkspaceScan,
    mapIdentityLifecycleError,
  } = dependencies
  const persistence = dependencies
  if (method === 'ops.users.list') {
      requirePlatformReadRole(req)
      const query = typeof params.query === 'string' ? params.query.trim().toLocaleLowerCase() : ''
      const status = typeof params.status === 'string' && params.status.trim() ? params.status.trim() : undefined
      if (status && !['invited', 'active', 'suspended'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 invited、active 或 suspended', 400)
      const targetWorkspaceId = typeof params.workspace_id === 'string' && params.workspace_id.trim() ? params.workspace_id.trim() : undefined
      const requestedLimit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 20
      const offset = typeof params.offset === 'string' && /^\d+$/u.test(params.offset) ? Number(params.offset) : 0
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 100 的整数', 400)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'offset 必须是 0 到 1000000 的整数', 400)
      const allWorkspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : [...knownWorkspaces]
      const scopedWorkspaceIds = targetWorkspaceId ? allWorkspaceIds.filter(id => id === targetWorkspaceId) : allWorkspaceIds
      const memberRepository = persistence.members ?? memoryMembers
      const platformAccounts = await passwordAuthRepository.listAccounts()
      const accountRows = platformAccounts
        .filter(account => account.accountType === 'platform')
        .map(account => ({
          id: account.id,
          identityId: account.identityId,
          externalSubject: account.login,
          displayName: account.contactName || account.login,
          enterpriseName: account.enterpriseName ?? '',
          role: account.roles[0] ?? 'platform_admin',
          status: account.status === 'revoked' ? 'suspended' : account.status,
          invitedBy: 'platform_account',
          revision: account.revision,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
          workspaceId: '',
          workspaceStatus: 'active' as const,
          accountType: 'platform' as const,
          scope: 'platform' as const,
        }))
      // Platform accounts are a second relation in the same directory: they carry
      // no workspace, they are never scoped to one, and they are small enough to
      // merge in memory. The member half is the one that grows with the platform.
      const visibleAccountRows = targetWorkspaceId ? [] : accountRows.filter(member => (!status || member.status === status) && (!query || memberMatchesQuery(member, query)))
      let pageRows: Array<typeof accountRows[number] | (WorkspaceMember & { enterpriseName: string; accountType: 'merchant'; scope: 'workspace' })>
      let total: number
      let identityCount: number
      let workspaceCount: number
      let scannedWorkspaceCount: number
      let scanTruncated: boolean
      if (memberRepository.searchWindow) {
        // The repository cuts the window and counts the totals in SQL. Its rows
        // are sorted and sliced here for the same reason the accounts are: the
        // two relations only sort correctly together once they are merged, and
        // `mergeMargin` is what makes the repository hand back a window wide
        // enough for account rows to push into it.
        //
        // A `query` matches the enterprise name, so it needs the name projection
        // for every workspace in scope. Without one only the page is rendered, and
        // the projection is read for the page's workspaces — the same values,
        // bounded by `limit` instead of by the platform.
        const searchNames = query ? await loadPlatformWorkspaceEnterpriseNames(scopedWorkspaceIds) : undefined
        const found = await memberRepository.searchWindow({
          workspaceIds: scopedWorkspaceIds,
          ...(status ? { status: status as MemberStatus } : {}),
          ...(query ? { query } : {}),
          offset,
          limit: requestedLimit,
          mergeMargin: visibleAccountRows.length,
          identityKeys: visibleAccountRows.map(memberIdentityKey),
          ...(searchNames ? { enterpriseNames: searchNames } : {}),
        })
        const pageNames = searchNames ?? await loadPlatformWorkspaceEnterpriseNames([...new Set(found.items.map(member => member.workspaceId))])
        const decorate = (member: WorkspaceMember) => ({ ...member, enterpriseName: pageNames.get(member.workspaceId) ?? DEFAULT_MEMBER_ENTERPRISE_NAME, accountType: 'merchant' as const, scope: 'workspace' as const })
        // `items` starts at `itemsFrom`, not at position 0, so the page is where
        // the window's own start sits below the caller's offset.
        const pageStart = offset - found.itemsFrom
        pageRows = [...found.items.map(decorate), ...visibleAccountRows].sort(compareMembersByRecency).slice(pageStart, pageStart + requestedLimit)
        total = found.total + visibleAccountRows.length
        identityCount = found.identityCount
        workspaceCount = found.workspaceCount
        // The scan now covers every workspace in scope, so it cannot be
        // truncated: `scan_truncated` stays in the response as a stable field and
        // reports `false` because it is `false`, not because the bound moved.
        scannedWorkspaceCount = scopedWorkspaceIds.length
        scanTruncated = false
      } else {
        const bounded = boundOpsUserWorkspaceScan(scopedWorkspaceIds)
        const memberRows = memberRepository.listMany
          ? await memberRepository.listMany(bounded.workspaceIds)
          : (await Promise.all(bounded.workspaceIds.map(id => memberRepository.list(id)))).flat()
        const enterpriseNames = await loadPlatformWorkspaceEnterpriseNames(bounded.workspaceIds)
        const filtered = [
          ...memberRows.map(member => ({ ...member, enterpriseName: enterpriseNames.get(member.workspaceId) ?? DEFAULT_MEMBER_ENTERPRISE_NAME, accountType: 'merchant' as const, scope: 'workspace' as const })),
          ...visibleAccountRows,
        ]
          .filter(member => (!status || member.status === status) && (!query || memberMatchesQuery(member, query)))
          .sort(compareMembersByRecency)
        pageRows = filtered.slice(offset, offset + requestedLimit)
        total = filtered.length
        identityCount = new Set(filtered.map(memberIdentityKey)).size
        workspaceCount = new Set(filtered.map(member => member.workspaceId).filter(Boolean)).size
        scannedWorkspaceCount = bounded.workspaceIds.length
        scanTruncated = bounded.scanTruncated
      }
      const pageWorkspaceIds = [...new Set(pageRows.map(member => member.workspaceId).filter(Boolean))]
      const workspaceStatuses = new Map(await mapWithConcurrency(pageWorkspaceIds, 8, async id => [id, await getWorkspaceStatus(id)] as const))
      const commercialSummaries = await loadPlatformUserCommercialSummaries(pageWorkspaceIds)
      const items = pageRows.map(member => ({ ...member, workspaceStatus: member.workspaceId ? workspaceStatuses.get(member.workspaceId) ?? 'active' : 'active', commercial: member.workspaceId ? commercialSummaries.get(member.workspaceId) : undefined }))
      // `truncated` means "this page is not the last one". `scanTruncated` is a
      // different fact and gets a different name: it is only reachable through
      // the bounded fallback above, where the workspace scan stopped at the bound
      // and `total`/`identityCount`/`workspaceCount` therefore describe the
      // scanned prefix — lower bounds on the platform totals. The window read
      // covers every workspace in scope, so it reports `false` and counts them
      // all.
      return ({ items, total, identityCount, workspaceCount, offset, limit: requestedLimit, truncated: offset + requestedLimit < total, scanned_workspace_count: scannedWorkspaceCount, scan_truncated: scanTruncated })
    }
  if (method === 'ops.users.export') {
      requirePlatformReadRole(req)
      const query = typeof params.query === 'string' ? params.query.trim().toLocaleLowerCase() : ''
      const status = typeof params.status === 'string' && params.status.trim() ? params.status.trim() : undefined
      if (status && !['invited', 'active', 'suspended'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 invited、active 或 suspended', 400)
      const targetWorkspaceId = typeof params.workspace_id === 'string' && params.workspace_id.trim() ? params.workspace_id.trim() : undefined
      const requestedLimit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Number(params.limit) : 5000
      if (params.format !== undefined && params.format !== 'csv' && params.format !== 'json') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'format 必须是 csv 或 json', 400)
      const format = params.format === 'json' ? 'json' : 'csv'
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 5000) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须是 1 到 5000 的整数', 400)
      const allWorkspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : [...knownWorkspaces]
      const workspaceIds = targetWorkspaceId ? allWorkspaceIds.filter(id => id === targetWorkspaceId) : allWorkspaceIds
      const memberRepository = persistence.members ?? memoryMembers
      // Filter and cap before enrichment. Platform test/prod history can contain
      // many workspaces; enriching every member would turn a narrow CSV export
      // into an unbounded fan-out across usage, subscription and wallet stores.
      //
      // A `query` matches the enterprise name, so it needs the name projection
      // for every workspace in scope; without one only the exported rows are
      // rendered, and the projection is read for their workspaces — the same
      // values, bounded by `limit` instead of by the platform.
      const searchNames = query ? await loadPlatformWorkspaceEnterpriseNames(workspaceIds) : undefined
      const enterpriseNameOf = (workspaceId: string, names: ReadonlyMap<string, string> | undefined) => names?.get(workspaceId) ?? DEFAULT_MEMBER_ENTERPRISE_NAME
      // The repository caps the export in SQL and already returns the rows in
      // the order below, but the sort stays: it is the shared definition of the
      // order, and the fallback path needs it anyway.
      const selectedMembers = memberRepository.searchWindow
        ? (await memberRepository.searchWindow({
            workspaceIds,
            ...(status ? { status: status as MemberStatus } : {}),
            ...(query ? { query } : {}),
            offset: 0,
            limit: requestedLimit,
            ...(searchNames ? { enterpriseNames: searchNames } : {}),
          })).items.sort(compareMembersByRecency).slice(0, requestedLimit)
        : (await (memberRepository.listMany
            ? memberRepository.listMany(workspaceIds)
            : Promise.all(workspaceIds.map(id => memberRepository.list(id))).then(rows => rows.flat())))
          .map(member => ({ ...member, enterpriseName: enterpriseNameOf(member.workspaceId, searchNames) }))
          .filter(member => (!status || member.status === status) && (!query || memberMatchesQuery(member, query)))
          .sort(compareMembersByRecency)
          .slice(0, requestedLimit)
      const selectedWorkspaceIds = [...new Set(selectedMembers.map(member => member.workspaceId))]
      const selectedNames = searchNames ?? await loadPlatformWorkspaceEnterpriseNames(selectedWorkspaceIds)
      const namedMembers = selectedMembers.map(member => ({ ...member, enterpriseName: enterpriseNameOf(member.workspaceId, selectedNames) }))
      const workspaceStatuses = new Map(await mapWithConcurrency(selectedWorkspaceIds, 8, async id => [id, await getWorkspaceStatus(id)] as const))
      const commercialSummaries = await loadPlatformUserCommercialSummaries(selectedWorkspaceIds)
      const filtered = namedMembers.map(member => ({ ...member, workspaceStatus: workspaceStatuses.get(member.workspaceId) ?? 'active', commercial: commercialSummaries.get(member.workspaceId) }))
      const rows = filtered.map(member => ({ external_subject: member.externalSubject, display_name: member.displayName, enterprise_name: member.enterpriseName, workspace_id: member.workspaceId, role: member.role, status: member.status, workspace_status: member.workspaceStatus, plan_code: member.commercial?.planCode ?? null, plan_name: member.commercial?.planName ?? null, subscription_status: member.commercial?.subscriptionStatus ?? null, used_tasks: member.commercial?.usedTasks ?? null, included_tasks: member.commercial?.includedTasks ?? null, remaining_tasks: member.commercial?.remainingTasks ?? null, wallet_balance_cny: member.commercial?.walletBalanceCny ?? null, invited_by: member.invitedBy ?? null, created_at: member.createdAt, updated_at: member.updatedAt }))
      if (format === 'json') return ({ filename: `ops-users-${new Date().toISOString().slice(0, 10)}.json`, content: JSON.stringify(rows, null, 2), count: rows.length, truncated: rows.length === requestedLimit })
      const headers = ['external_subject', 'display_name', 'workspace_id', 'enterprise_name', 'role', 'status', 'workspace_status', 'plan_code', 'plan_name', 'subscription_status', 'used_tasks', 'included_tasks', 'remaining_tasks', 'wallet_balance_cny', 'invited_by', 'created_at', 'updated_at']
      const content = [headers.join(','), ...rows.map(row => headers.map(header => csvCell(String(row[header as keyof typeof row] ?? ''))).join(','))].join('\n')
      return ({ filename: `ops-users-${new Date().toISOString().slice(0, 10)}.csv`, content, count: rows.length, truncated: rows.length === requestedLimit })
    }
  if (method === 'ops.user.detail') {
      requirePlatformReadRole(req)
      const requestedIdentityId = typeof params.identity_id === 'string' && params.identity_id.trim() ? params.identity_id.trim() : undefined
      const externalSubject = typeof params.external_subject === 'string' && params.external_subject.trim() ? params.external_subject.trim() : undefined
      if (!requestedIdentityId && !externalSubject) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'identity_id 或 external_subject 至少提供一个', 400)
      let identityDetail: IdentityOperationsDetail | undefined
      try {
        const repository = persistence.identities ?? memoryIdentities
        const identity = requestedIdentityId
          ? undefined
          : await repository.resolve({ issuer: typeof params.issuer === 'string' && params.issuer.trim() ? params.issuer.trim() : 'urn:merchant:api-token', externalSubject: externalSubject! })
        if (requestedIdentityId || identity) identityDetail = await repository.detailForOperations(requestedIdentityId ?? identity!.id)
      } catch (error) { mapIdentityLifecycleError(error) }
      const allWorkspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : [...knownWorkspaces]
      const memberRepository = persistence.members ?? memoryMembers
      const accountForSubject = externalSubject
        ? (await passwordAuthRepository.listAccounts()).find(account => account.login === externalSubject)
        : undefined
      if (!identityDetail && accountForSubject?.identityId) {
        try {
          identityDetail = await (persistence.identities ?? memoryIdentities).detailForOperations(accountForSubject.identityId)
        } catch (error) { mapIdentityLifecycleError(error) }
      }
      const resolvedIdentityId = requestedIdentityId ?? identityDetail?.identity.id ?? accountForSubject?.identityId
      // One membership is a point lookup, not a directory read: asking the
      // repository for the subject keeps this endpoint off the path that used to
      // load every member of every workspace to find one person.
      const matchingMembers = memberRepository.findBySubject
        ? await memberRepository.findBySubject({
            workspaceIds: allWorkspaceIds,
            ...(resolvedIdentityId ? { identityId: resolvedIdentityId } : {}),
            ...(externalSubject ? { externalSubject } : {}),
          })
        : (await (memberRepository.listMany
            ? memberRepository.listMany(allWorkspaceIds)
            : Promise.all(allWorkspaceIds.map(id => memberRepository.list(id))).then(rows => rows.flat())))
          .filter(member => resolvedIdentityId
            ? member.identityId === resolvedIdentityId || member.externalSubject === externalSubject
            : member.externalSubject === externalSubject)
      if (!matchingMembers.length && !identityDetail) throw new DomainError('USER_IDENTITY_NOT_FOUND', '未找到该平台身份或成员关系', 404)
      const workspaceStatuses = new Map(await Promise.all(matchingMembers.map(async member => [member.workspaceId, await getWorkspaceStatus(member.workspaceId)] as const)))
      const matchingWorkspaceIds = [...new Set(matchingMembers.map(member => member.workspaceId))]
      const enterpriseNames = await loadPlatformWorkspaceEnterpriseNames(matchingWorkspaceIds)
      const commercialSummaries = await loadPlatformUserCommercialSummaries(matchingWorkspaceIds)
      const memberships = matchingMembers
        .map(member => ({ ...member, enterpriseName: enterpriseNames.get(member.workspaceId) ?? '未命名企业主体', workspaceStatus: workspaceStatuses.get(member.workspaceId) ?? 'active', commercial: commercialSummaries.get(member.workspaceId) }))
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      const auditRepository = persistence.operations ?? memoryOperations
      const audits = (await Promise.all([...new Set(matchingMembers.map(member => member.workspaceId))].map(id => auditRepository.list(id, 200))))
        .flat()
        .filter(audit => audit.resourceType === 'workspace_member' && audit.resourceId === (externalSubject ?? identityDetail?.identity.externalSubject))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 100)
      return ({
        identity: {
          ...(identityDetail?.identity ?? {}),
          externalSubject: identityDetail?.identity.externalSubject ?? externalSubject,
          displayName: identityDetail?.identity.displayName || memberships.find(member => member.displayName)?.displayName || '',
          membershipCount: memberships.length,
          activeMembershipCount: memberships.filter(member => member.status === 'active' && member.workspaceStatus === 'active').length,
          firstSeenAt: identityDetail?.identity.firstSeenAt ?? memberships[0]?.createdAt ?? null,
          lastUpdatedAt: identityDetail?.identity.updatedAt ?? memberships[0]?.updatedAt ?? null,
        },
        memberships,
        audits,
        sessions: identityDetail?.sessions.map(({ providerSessionHash: _providerSessionHash, ipHash: _ipHash, userAgentHash: _userAgentHash, ...session }) => session) ?? [],
        lifecycleEvents: identityDetail?.events.map(event => ({
          id: event.id,
          eventType: event.eventType,
          actorId: event.actorId,
          reason: redactAuditReason(event.reason),
          evidence: redactAuditEvidence(event.evidence),
          createdAt: event.createdAt,
        })) ?? [],
      })
    }
  throw new Error(`Unsupported user MCP method: ${method}`)
}
