import { describe, expect, it, vi } from 'vitest'
import { aliyunEcsRamRoleCredentialProvider } from './aliyun-ecs-role-credentials.js'

describe('aliyunEcsRamRoleCredentialProvider', () => {
  it('returns temporary credentials from the bound ECS role', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('metadata-token'))
      .mockResolvedValueOnce(new Response('StoreNovaEcsOssRole'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Code: 'Success', AccessKeyId: 'temporary-id', AccessKeySecret: 'temporary-secret',
        SecurityToken: 'temporary-token', Expiration: '2026-09-14T15:47:09Z',
      }), { headers: { 'content-type': 'application/json' } }))

    await expect(aliyunEcsRamRoleCredentialProvider({ fetchImpl, metadataBaseUrl: 'http://metadata.test/latest/' })()).resolves.toMatchObject({
      accessKeyId: 'temporary-id', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-token',
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://metadata.test/latest/meta-data/ram/security-credentials/', expect.objectContaining({ headers: expect.objectContaining({ 'X-aliyun-ecs-metadata-token': 'metadata-token' }) }))
  })

  it('fails closed when the metadata document is incomplete', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('token unavailable'))
      .mockResolvedValueOnce(new Response('role'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Code: 'Success', AccessKeyId: 'id' })))
    await expect(aliyunEcsRamRoleCredentialProvider({ fetchImpl })()).rejects.toThrow('ALIYUN_ECS_RAM_ROLE_CREDENTIALS_INVALID')
  })
})
