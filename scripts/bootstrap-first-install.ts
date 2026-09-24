import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { PostgresPasswordAuthRepository } from '../packages/persistence/src/password-auth-repository.js'
import { PostgresFirstWorkspaceProvisioningRepository } from '../packages/persistence/src/first-workspace-provisioning-repository.js'

const required = (env: NodeJS.ProcessEnv, key: string) => {
  const value = env[key]?.trim()
  if (!value) throw new Error(`FIRST_INSTALL_CONFIG_MISSING_${key}`)
  return value
}

async function secret(env: NodeJS.ProcessEnv, name: string) {
  const direct = env[name]
  const path = env[`${name}_FILE`]
  if (Boolean(direct) === Boolean(path)) throw new Error(`FIRST_INSTALL_SECRET_SOURCE_INVALID_${name}`)
  if (direct) return direct
  const handle = await open(path!, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > 2048) throw new Error(`FIRST_INSTALL_SECRET_FILE_UNSAFE_${name}`)
    return (await handle.readFile('utf8')).replace(/\r?\n$/u, '')
  } finally { await handle.close() }
}

export async function runFirstInstall(env: NodeJS.ProcessEnv = process.env) {
  const workspaceId = required(env, 'FIRST_INSTALL_WORKSPACE_ID')
  if (workspaceId !== 'ws_guirenniaoniao') throw new Error('FIRST_INSTALL_WORKSPACE_ID_UNEXPECTED')
  const adminLogin = required(env, 'FIRST_INSTALL_PLATFORM_LOGIN').toLowerCase()
  const merchantLogin = required(env, 'FIRST_INSTALL_MERCHANT_LOGIN').toLowerCase()
  if (adminLogin === merchantLogin) throw new Error('FIRST_INSTALL_IDENTITIES_NOT_DISTINCT')
  const enterpriseName = required(env, 'FIRST_INSTALL_ENTERPRISE_NAME')
  const ownerName = required(env, 'FIRST_INSTALL_MERCHANT_DISPLAY_NAME')
  const reason = required(env, 'FIRST_INSTALL_REASON')
  if (reason.length < 3) throw new Error('FIRST_INSTALL_REASON_INVALID')
  if (env.FIRST_INSTALL_MERCHANT_TERMS_AGREED !== 'true') throw new Error('FIRST_INSTALL_MERCHANT_TERMS_NOT_CONFIRMED')
  const platformHash = await secret(env, 'FIRST_INSTALL_PLATFORM_PASSWORD_HASH')
  const merchantPassword = await secret(env, 'FIRST_INSTALL_MERCHANT_PASSWORD')
  const opsDatabaseUrl = required(env, 'FIRST_INSTALL_OPS_DATABASE_URL')
  const adminDatabaseUrl = required(env, 'FIRST_INSTALL_ADMIN_DATABASE_URL')
  const opsTarget = new URL(opsDatabaseUrl)
  const adminTarget = new URL(adminDatabaseUrl)
  if (!['postgres:', 'postgresql:'].includes(opsTarget.protocol) || !['postgres:', 'postgresql:'].includes(adminTarget.protocol)
    || opsTarget.username !== 'merchant_ops' || !adminTarget.username || ['merchant_ops', 'merchant_app'].includes(adminTarget.username)
    || opsTarget.hostname !== adminTarget.hostname || opsTarget.port !== adminTarget.port || opsTarget.pathname !== adminTarget.pathname)
    throw new Error('FIRST_INSTALL_DATABASE_ROLES_INVALID')
  const opsPool = new Pool({ connectionString: opsDatabaseUrl, max: 2 })
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 })
  try {
    const accounts = new PostgresPasswordAuthRepository(opsPool)
    const admin = await accounts.bootstrapFirstPlatformAdmin({ login: adminLogin, passwordHash: platformHash })
    const matching = (await accounts.listAccounts()).filter(account => account.login === merchantLogin)
    if (matching.length > 1 || matching[0] && (matching[0].accountType !== 'merchant' || !['merchant_pending', 'active'].includes(matching[0].status))) throw new Error('FIRST_INSTALL_MERCHANT_ACCOUNT_CONFLICT')
    const owner = matching[0] ?? (await accounts.register({ login: merchantLogin, password: merchantPassword, enterpriseName, contactName: ownerName, termsAgreed: true })).account
    if (owner.status === 'active' && (owner.workspaceIds.length !== 1 || owner.workspaceIds[0] !== workspaceId)) throw new Error('FIRST_INSTALL_MERCHANT_ACCOUNT_CONFLICT')
    const workspace = await new PostgresFirstWorkspaceProvisioningRepository(adminPool).provision({
      platformActorIdentityId: admin.identityId, workspaceId,
      ownerIdentityId: owner.identityId, ownerIssuer: 'damai-password', ownerSubject: merchantLogin,
      ownerDisplayName: ownerName, reason,
    })
    if (owner.status === 'merchant_pending') await accounts.activateMerchantAccount({ login: merchantLogin, workspaceIds: [workspaceId], actorId: admin.identityId, reason })
    return { platformIdentityId: admin.identityId, platformStatus: admin.status, merchantIdentityId: owner.identityId, workspaceId, workspaceCreated: workspace.created }
  } finally { await Promise.all([opsPool.end(), adminPool.end()]) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFirstInstall().then(result => {
    process.stdout.write(`${JSON.stringify({ status: 'complete', ...result })}\n`)
  }).catch(error => {
    process.stderr.write(`FIRST_INSTALL_FAILED: ${error instanceof Error ? error.message : 'UNKNOWN'}\n`)
    process.exitCode = 1
  })
}
