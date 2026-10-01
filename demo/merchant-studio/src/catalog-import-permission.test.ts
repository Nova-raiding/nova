import { describe, expect, it } from 'vitest'
import { canImportCatalogForAccount } from './App.js'

describe('商品表格导入权限提示', () => {
  it('只为工作区数据写入角色开放导入按钮', () => {
    expect(canImportCatalogForAccount({ roles: ['workspace_owner'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ roles: ['merchant_admin'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ roles: ['operator'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ roles: ['support'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ roles: ['platform_ops'] } as never)).toBe(true)
    expect(canImportCatalogForAccount({ roles: ['finance'] } as never)).toBe(false)
    expect(canImportCatalogForAccount(null)).toBe(false)
  })
})
