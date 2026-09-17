import { describe, expect, it } from 'vitest'
import { createManualStoreAccount, prepareManualStoreBatchImport } from './manual-store-import.js'

describe('manual store product import boundary', () => {
  const account = createManualStoreAccount({ workspaceId: 'ws_merchant', platform: 'taobao', storeName: '旗舰店', merchantStoreKey: 'merchant-shop-001' })

  it('creates a stable non-secret manual store identity without a fake Vault credential', () => {
    expect(account).toEqual(expect.objectContaining({ id: expect.stringMatching(/^manual_store_[a-f0-9]{24}$/u), integrationMode: 'manual_operated', status: 'active' }))
    expect(createManualStoreAccount({ workspaceId: 'ws_merchant', platform: 'taobao', storeName: '新名称', merchantStoreKey: 'merchant-shop-001' }).id).toBe(account.id)
    expect(JSON.stringify(account)).not.toMatch(/credential|token|secret|cookie|password/iu)
    expect(() => createManualStoreAccount({ workspaceId: 'ws_merchant', platform: 'taobao', storeName: '伪凭据店铺', merchantStoreKey: 'vault://fake-account' })).toThrowError(expect.objectContaining({ code: 'MANUAL_STORE_KEY_SECRET_LIKE' }))
  })

  it('binds every imported product to an active manual store in the same workspace and platform', () => {
    const result = prepareManualStoreBatchImport({ workspaceId: 'ws_merchant', accounts: [account], products: [
      { platform: 'taobao', account_id: account.id, local_product_key: 'sku-family-1', title: '轻云外套' },
      { platform: 'taobao', account_id: account.id, local_product_key: 'sku-family-2', title: '城市背包' },
    ] })
    expect(result.accountIds).toEqual([account.id])
    expect(result.products).toHaveLength(2)
  })

  it.each([
    [{ platform: 'taobao', title: '缺少店铺' }, 'MANUAL_IMPORT_ACCOUNT_REQUIRED'],
    [{ platform: 'jd', account_id: account.id, title: '平台错配' }, 'MANUAL_IMPORT_ACCOUNT_PLATFORM_MISMATCH'],
    [{ platform: 'taobao', account_id: account.id, title: '含凭据', access_token: 'do-not-store' }, 'MANUAL_IMPORT_SECRET_FORBIDDEN'],
    [{ platform: 'taobao', account_id: account.id, title: '嵌套凭据', metadata: { cookie: 'do-not-store' } }, 'MANUAL_IMPORT_SECRET_FORBIDDEN'],
  ])('fails closed for invalid manual row %#', (product, code) => {
    expect(() => prepareManualStoreBatchImport({ workspaceId: 'ws_merchant', accounts: [account], products: [product] })).toThrowError(expect.objectContaining({ code }))
  })

  it('rejects cross-workspace and archived store identities', () => {
    expect(() => prepareManualStoreBatchImport({ workspaceId: 'ws_other', accounts: [account], products: [{ platform: 'taobao', account_id: account.id, title: '越权商品' }] })).toThrowError(expect.objectContaining({ code: 'MANUAL_IMPORT_ACCOUNT_NOT_FOUND' }))
    expect(() => prepareManualStoreBatchImport({ workspaceId: 'ws_merchant', accounts: [{ ...account, status: 'archived' }], products: [{ platform: 'taobao', account_id: account.id, title: '归档店铺' }] })).toThrowError(expect.objectContaining({ code: 'MANUAL_IMPORT_ACCOUNT_NOT_FOUND' }))
  })

  it('rejects a credential-bearing object even if it is presented as a manual account', () => {
    const unsafe = { ...account, credentialRef: 'vault://fake-manual-account' }
    expect(() => prepareManualStoreBatchImport({ workspaceId: 'ws_merchant', accounts: [unsafe], products: [{ platform: 'taobao', account_id: account.id, title: '不应导入' }] })).toThrowError(expect.objectContaining({ code: 'MANUAL_STORE_CREDENTIAL_FORBIDDEN' }))
  })
})
