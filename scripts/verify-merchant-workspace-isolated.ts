import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { PostgresMembersRepository } from '../packages/persistence/src/members-repository.js'
import { PostgresPasswordAuthRepository } from '../packages/persistence/src/password-auth-repository.js'
import { runOpsE2e, type OpsE2eContext } from './run-ops-password-e2e.js'

export const MERCHANT_WORKSPACE_SWITCH_SPEC = 'demo/merchant-studio/merchant-workspace-switch.browser.spec.js'

async function seedDualWorkspaceMerchant({ fixture, evidenceDir, environment }: OpsE2eContext) {
  const workspaceB = `ws_scope_${fixture.runId.replaceAll('-', '')}`
  const login = `merchant-scope-${fixture.runId}@fixture.invalid`
  const password = `A1${randomBytes(24).toString('hex')}`
  const admin = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 2 })
  const ops = new Pool({ connectionString: fixture.opsDatabaseUrl, max: 1 })
  try {
    const adminIdentity = await admin.query<{ role: string; database: string }>('SELECT current_user AS role, current_database() AS database')
    if (adminIdentity.rows[0]?.role !== 'merchant' || adminIdentity.rows[0]?.database !== 'merchant') {
      throw new Error('MERCHANT_WORKSPACE_FIXTURE_ADMIN_SCOPE_INVALID')
    }
    await admin.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [workspaceB])

    const account = await new PostgresPasswordAuthRepository(ops).createMerchantAccount({
      login,
      password,
      enterpriseName: '隔离多工作区验收企业',
      contactName: '隔离多工作区管理员',
      workspaceIds: [fixture.workspaceId, workspaceB],
      actorId: 'isolated-browser-fixture',
      reason: 'isolated browser verification of authorized workspace switching',
    })
    if (account.workspaceIds.length !== 2 || !account.workspaceIds.includes(fixture.workspaceId) || !account.workspaceIds.includes(workspaceB)) {
      throw new Error('MERCHANT_WORKSPACE_FIXTURE_ACCOUNT_SCOPE_INVALID')
    }

    const members = new PostgresMembersRepository(admin)
    for (const workspaceId of [fixture.workspaceId, workspaceB]) {
      await members.upsert({ workspaceId, externalSubject: login, displayName: '隔离多工作区管理员', role: 'merchant_admin', status: 'active', invitedBy: 'isolated-browser-fixture' })
      if (account.identityId) await members.bindIdentity({ workspaceId, externalSubject: login, identityId: account.identityId })
    }
    await members.upsert({ workspaceId: fixture.workspaceId, externalSubject: 'a-only@example.invalid', displayName: 'A 工作区专属成员', role: 'operator', status: 'active', invitedBy: 'isolated-browser-fixture' })
    await members.upsert({ workspaceId: workspaceB, externalSubject: 'b-only@example.invalid', displayName: 'B 工作区专属成员', role: 'operator', status: 'active', invitedBy: 'isolated-browser-fixture' })

    environment.OPS_E2E_MERCHANT_USERNAME = login
    environment.OPS_E2E_MERCHANT_PASSWORD = password
    environment.OPS_E2E_MERCHANT_WORKSPACE_A = fixture.workspaceId
    environment.OPS_E2E_MERCHANT_WORKSPACE_B = workspaceB
    await mkdir(resolve(evidenceDir, 'merchant-workspace-switch'), { recursive: true, mode: 0o700 })
    await writeFile(resolve(evidenceDir, 'merchant-workspace-switch', 'fixture.json'), JSON.stringify({
      workspaceA: fixture.workspaceId,
      workspaceB,
      accountId: account.id,
      identityId: account.identityId,
      memberships: 2,
      aOnlyMember: 'a-only@example.invalid',
      bOnlyMember: 'b-only@example.invalid',
      productionBrowser: false,
      modelCalls: 0,
    }, null, 2), { mode: 0o600, flag: 'wx' })
  } finally {
    await ops.end()
    await admin.end()
  }
}

const source = {
  ...process.env,
  OPS_E2E_MERCHANT_UI: 'true',
  OPS_E2E_MERCHANT_WORKSPACE_SWITCH: 'true',
}
runOpsE2e([MERCHANT_WORKSPACE_SWITCH_SPEC, '--workers=1'], source, undefined, seedDualWorkspaceMerchant)
  .then(code => { process.exitCode = code })
  .catch(error => {
    console.error(error instanceof Error ? error.message : 'MERCHANT_WORKSPACE_SWITCH_RUN_FAILED')
    process.exitCode = 1
  })
