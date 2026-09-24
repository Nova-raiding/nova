import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runFirstInstall } from '../scripts/bootstrap-first-install.js'

const base = {
  FIRST_INSTALL_WORKSPACE_ID: 'ws_guirenniaoniao',
  FIRST_INSTALL_PLATFORM_LOGIN: 'admin@example.com',
  FIRST_INSTALL_MERCHANT_LOGIN: 'merchant@example.com',
  FIRST_INSTALL_ENTERPRISE_NAME: 'Example Enterprise',
  FIRST_INSTALL_MERCHANT_DISPLAY_NAME: 'Owner',
  FIRST_INSTALL_REASON: 'Initial verified installation',
  FIRST_INSTALL_MERCHANT_TERMS_AGREED: 'true',
  FIRST_INSTALL_PLATFORM_PASSWORD_HASH: '$argon2id$v=19$m=19456,p=1,t=2$invalid$invalid',
  FIRST_INSTALL_MERCHANT_PASSWORD: 'MerchantPass123',
  FIRST_INSTALL_OPS_DATABASE_URL: 'postgresql://unused@example.invalid/unused',
  FIRST_INSTALL_ADMIN_DATABASE_URL: 'postgresql://unused@example.invalid/unused',
}

describe('first install CLI input gate', () => {
  it('rejects the wrong workspace and missing merchant consent before connecting', async () => {
    await expect(runFirstInstall({ ...base, FIRST_INSTALL_WORKSPACE_ID: 'ws_other' })).rejects.toThrow('FIRST_INSTALL_WORKSPACE_ID_UNEXPECTED')
    await expect(runFirstInstall({ ...base, FIRST_INSTALL_MERCHANT_TERMS_AGREED: 'false' })).rejects.toThrow('FIRST_INSTALL_MERCHANT_TERMS_NOT_CONFIRMED')
    await expect(runFirstInstall({ ...base, FIRST_INSTALL_MERCHANT_LOGIN: base.FIRST_INSTALL_PLATFORM_LOGIN })).rejects.toThrow('FIRST_INSTALL_IDENTITIES_NOT_DISTINCT')
  })

  it('rejects a readable-by-group secret before connecting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'first-install-secret-'))
    const path = join(directory, 'password')
    try {
      await writeFile(path, 'MerchantPass123\n', { mode: 0o600 })
      await chmod(path, 0o640)
      const env = { ...base, FIRST_INSTALL_MERCHANT_PASSWORD: undefined, FIRST_INSTALL_MERCHANT_PASSWORD_FILE: path }
      await expect(runFirstInstall(env)).rejects.toThrow('FIRST_INSTALL_SECRET_FILE_UNSAFE_FIRST_INSTALL_MERCHANT_PASSWORD')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('requires distinct operations and schema-owner database roles', async () => {
    await expect(runFirstInstall({ ...base, FIRST_INSTALL_OPS_DATABASE_URL: 'postgresql://merchant_ops@example.invalid/unused', FIRST_INSTALL_ADMIN_DATABASE_URL: 'postgresql://merchant_ops@example.invalid/unused' })).rejects.toThrow('FIRST_INSTALL_DATABASE_ROLES_INVALID')
  })
})
