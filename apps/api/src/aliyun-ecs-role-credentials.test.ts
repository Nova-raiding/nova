import { describe, expect, it, vi } from 'vitest'
import { createAliyunEcsRoleCredentials } from './aliyun-ecs-role-credentials.js'

describe('Aliyun ECS RAM role credentials', () => {
  it('uses the official provider with IMDSv2-only and maps the STS token', async () => {
    const getCredential = vi.fn().mockResolvedValue({ accessKeyId: 'sts-id', accessKeySecret: 'sts-secret', securityToken: 'sts-token' })
    const createClient = vi.fn(() => ({ getCredential }))
    const provider = createAliyunEcsRoleCredentials('merchant-oss-role', createClient)
    expect(await provider()).toEqual({ accessKeyId: 'sts-id', secretAccessKey: 'sts-secret', sessionToken: 'sts-token' })
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ type: 'ecs_ram_role', roleName: 'merchant-oss-role', disableIMDSv1: true }))
  })

  it('rejects unsafe role names and incomplete temporary credentials', async () => {
    expect(() => createAliyunEcsRoleCredentials('../role')).toThrow('ASSET_STORAGE_ECS_RAM_ROLE_INVALID')
    const provider = createAliyunEcsRoleCredentials('role', () => ({ getCredential: async () => ({ accessKeyId: 'id' }) }))
    await expect(provider()).rejects.toThrow('ALIYUN_ECS_RAM_ROLE_CREDENTIALS_INVALID')
  })
})
