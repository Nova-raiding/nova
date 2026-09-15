import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { collectAliyunOssControlPlane, type CommandExecutor } from '../scripts/collect-aliyun-oss-control-plane.js'

const ok = (stdout: unknown) => ({ status: 0, stdout: JSON.stringify(stdout), stderr: '' })

describe('Aliyun OSS read-only control-plane collector', () => {
  const lifecycleRuleId = 'store-nova-merchant-assets-retention'
  const lifecycleRule = {
    ID: lifecycleRuleId,
    Prefix: 'merchant-assets/',
    Status: 'Enabled',
    AbortMultipartUpload: { Days: 7 },
    Expiration: { ExpiredObjectDeleteMarker: true },
  }

  it('uses only the three read APIs and verifies all required controls', async () => {
    const execute = vi.fn<CommandExecutor>((_binary, args) => {
      if (args.includes('get-bucket-versioning')) return ok({ VersioningConfiguration: { Status: 'Enabled' } })
      if (args.includes('get-bucket-lifecycle')) return ok({ LifecycleConfiguration: { Rule: [lifecycleRule, { ID: 'old', Status: 'Disabled' }] } })
      return ok({ PublicAccessBlockConfiguration: { BlockPublicAccess: true } })
    })
    const result = await collectAliyunOssControlPlane({ bucket: 'merchant-assets', region: 'cn-hangzhou', lifecycleRuleId, endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', execute, now: () => new Date('2026-09-14T12:00:00Z') })
    expect(result).toMatchObject({ ready: true, mode: 'read-only', region: 'cn-hangzhou', lifecycle_rule_id_sha256: createHash('sha256').update('store-nova-merchant-assets-retention').digest('hex'), checks: { versioning_enabled: { state: 'passed', observed: true }, lifecycle_enabled_rules: { state: 'passed', observed: 1 }, public_access_blocked: { state: 'passed', observed: true } } })
    expect(execute).toHaveBeenCalledTimes(3)
    for (const [, args] of execute.mock.calls) {
      expect(args.slice(0, 2)).toEqual(['api', expect.stringMatching(/^get-/u)])
      expect(args).toEqual(expect.arrayContaining(['--mode', 'EcsRamRole', '--region', 'cn-hangzhou']))
      expect(args).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(put|delete|set)-/u)]))
    }
    expect(JSON.stringify(result)).not.toContain('merchant-assets')
  })

  it('distinguishes permission denial, absent configuration, and unsupported API', async () => {
    const execute: CommandExecutor = (_binary, args) => {
      if (args.includes('get-bucket-versioning')) return { status: 1, stdout: '', stderr: 'AccessDenied: status code 403' }
      if (args.includes('get-bucket-lifecycle')) return { status: 1, stdout: '', stderr: 'NoSuchLifecycle: status code 404' }
      return { status: 1, stdout: '', stderr: 'unknown command: get-bucket-public-access-block' }
    }
    const result = await collectAliyunOssControlPlane({ bucket: 'merchant-assets', region: 'cn-hangzhou', lifecycleRuleId, execute })
    expect(result.ready).toBe(false)
    expect(result.checks.versioning_enabled).toMatchObject({ state: 'blocked', reason: 'permission_denied' })
    expect(result.checks.lifecycle_enabled_rules).toMatchObject({ state: 'blocked', reason: 'not_configured' })
    expect(result.checks.public_access_blocked).toMatchObject({ state: 'blocked', reason: 'unsupported' })
  })

  it('fails controls closed for disabled and malformed successful responses', async () => {
    const responses = [ok({ Status: 'Suspended' }), ok({ Rule: [] }), { status: 0, stdout: 'not-json', stderr: '' }]
    const result = await collectAliyunOssControlPlane({ bucket: 'merchant-assets', region: 'cn-hangzhou', lifecycleRuleId, execute: vi.fn(() => responses.shift()!) })
    expect(result.checks.versioning_enabled).toEqual({ state: 'failed', reason: 'disabled', observed: false })
    expect(result.checks.lifecycle_enabled_rules).toEqual({ state: 'failed', reason: 'not_configured', observed: 0 })
    expect(result.checks.public_access_blocked).toEqual({ state: 'blocked', reason: 'invalid_response', observed: null })
  })

  it('rejects unsafe bucket and endpoint input before command execution', async () => {
    const execute = vi.fn<CommandExecutor>()
    await expect(collectAliyunOssControlPlane({ bucket: '../bucket', region: 'cn-hangzhou', lifecycleRuleId, execute })).rejects.toThrow('OSS_BUCKET_INVALID')
    await expect(collectAliyunOssControlPlane({ bucket: 'valid-bucket', region: 'cn-hangzhou', lifecycleRuleId, endpoint: 'http://oss.example.com', execute })).rejects.toThrow('OSS_ENDPOINT_INVALID')
    await expect(collectAliyunOssControlPlane({ bucket: 'valid-bucket', region: '../bad', lifecycleRuleId, execute })).rejects.toThrow('OSS_REGION_INVALID')
    await expect(collectAliyunOssControlPlane({ bucket: 'valid-bucket', region: 'cn-hangzhou', lifecycleRuleId: '../bad', execute })).rejects.toThrow('OSS_LIFECYCLE_RULE_ID_INVALID')
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    ['unrelated enabled rule', { ...lifecycleRule, ID: 'some-other-rule' }],
    ['wrong prefix', { ...lifecycleRule, Prefix: 'other/' }],
    ['wrong multipart retention', { ...lifecycleRule, AbortMultipartUpload: { Days: 8 } }],
    ['delete marker cleanup disabled', { ...lifecycleRule, Expiration: { ExpiredObjectDeleteMarker: false } }],
  ])('fails closed for %s', async (_label, rule) => {
    const execute: CommandExecutor = (_binary, args) => {
      if (args.includes('get-bucket-versioning')) return ok({ Status: 'Enabled' })
      if (args.includes('get-bucket-lifecycle')) return ok({ Rule: [rule] })
      return ok({ BlockPublicAccess: true })
    }
    const result = await collectAliyunOssControlPlane({ bucket: 'merchant-assets', region: 'cn-hangzhou', lifecycleRuleId, execute })
    expect(result.ready).toBe(false)
    expect(result.checks.lifecycle_enabled_rules).toMatchObject({ state: 'failed', observed: 0 })
  })
})
