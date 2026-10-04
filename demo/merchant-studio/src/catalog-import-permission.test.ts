import { describe, expect, it } from 'vitest'
import { canImportCatalogForAccount } from './App.js'

describe('商品表格导入权限提示', () => {
  it('只为激活商家或工作区写入角色开放导入按钮', () => {
    const active = { status: 'active' }
    expect(canImportCatalogForAccount({ ...active, accountType: 'merchant', roles: ['merchant'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ ...active, roles: ['workspace_owner'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ ...active, roles: ['merchant_admin'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ ...active, roles: ['operator'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ ...active, roles: ['support'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ ...active, roles: ['platform_ops'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ ...active, roles: ['finance'] } as never)).toBe(false)
    expect(canImportCatalogForAccount({ ...active, accountType: 'merchant', roles: ['merchant'], status: 'suspended' } as never)).toBe(false)
    expect(canImportCatalogForAccount({ ...active, accountType: 'merchant', roles: ['merchant'], status: 'merchant_pending' } as never)).toBe(false)
    expect(canImportCatalogForAccount(null)).toBe(false)
  })
})
