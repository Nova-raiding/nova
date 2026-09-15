import { describe, expect, it, vi } from 'vitest'
import { createAliyunAckRrsaCredentials, validateAliyunAckRrsaEnvironment } from './aliyun-ack-rrsa-credentials.js'

const valid = {
  ALIBABA_CLOUD_ROLE_ARN: 'acs:ram::1600188311395090:role/StoreNovaAckOssRole',
  ALIBABA_CLOUD_OIDC_PROVIDER_ARN: 'acs:ram::1600188311395090:oidc-provider/ack-rrsa-cluster1',
  ALIBABA_CLOUD_OIDC_TOKEN_FILE: '/var/run/secrets/ack.alibabacloud.com/rrsa-tokens/token',
  ALIBABA_CLOUD_STS_ENDPOINT: 'sts-vpc.cn-hangzhou.aliyuncs.com',
}

describe('Aliyun ACK RRSA credentials', () => {
  it('accepts only the pod-scoped RRSA injection contract', () => {
    expect(validateAliyunAckRrsaEnvironment(valid)).toMatchObject({ roleArn: valid.ALIBABA_CLOUD_ROLE_ARN, oidcTokenFilePath: valid.ALIBABA_CLOUD_OIDC_TOKEN_FILE })
  })

  it.each([
    ['ALIBABA_CLOUD_ROLE_ARN', ''],
    ['ALIBABA_CLOUD_OIDC_PROVIDER_ARN', 'not-an-arn'],
    ['ALIBABA_CLOUD_OIDC_TOKEN_FILE', '/var/run/secrets/kubernetes.io/serviceaccount/token'],
    ['ALIBABA_CLOUD_STS_ENDPOINT', 'https://evil.example.test'],
  ] as const)('fails closed for %s', (key, value) => {
    expect(() => validateAliyunAckRrsaEnvironment({ ...valid, [key]: value })).toThrow()
  })

  it('uses the official OIDC role provider with bounded STS timeouts and maps only complete temporary credentials', async () => {
    const getCredential = vi.fn().mockResolvedValue({ accessKeyId: ' sts-id ', accessKeySecret: ' sts-secret ', securityToken: ' sts-token ' })
    const createClient = vi.fn(() => ({ getCredential }))
    const provider = createAliyunAckRrsaCredentials(valid, createClient)

    await expect(provider()).resolves.toEqual({ accessKeyId: 'sts-id', secretAccessKey: 'sts-secret', sessionToken: 'sts-token' })
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      type: 'oidc_role_arn',
      roleArn: valid.ALIBABA_CLOUD_ROLE_ARN,
      oidcProviderArn: valid.ALIBABA_CLOUD_OIDC_PROVIDER_ARN,
      oidcTokenFilePath: valid.ALIBABA_CLOUD_OIDC_TOKEN_FILE,
      stsEndpoint: valid.ALIBABA_CLOUD_STS_ENDPOINT,
      roleSessionName: 'store-nova-api',
      roleSessionExpiration: 3_600,
      connectTimeout: 1_000,
      timeout: 2_000,
    }))
  })

  it('rejects incomplete or whitespace-only temporary credentials without exposing their values', async () => {
    const provider = createAliyunAckRrsaCredentials(valid, () => ({
      getCredential: async () => ({ accessKeyId: 'sts-id', accessKeySecret: ' ', securityToken: 'sts-token' }),
    }))

    await expect(provider()).rejects.toThrow('ALIYUN_ACK_RRSA_CREDENTIALS_INVALID')
  })
})
