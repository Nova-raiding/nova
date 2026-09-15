import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type RamPolicy = {
  Version: string
  Statement: Array<{ Effect: string; Action: string[]; Resource: string[] }>
}

describe('Aliyun OSS canary RAM policy patch', () => {
  const policy = JSON.parse(readFileSync(resolve('infra/aliyun/ram/StoreNovaOssBucketAccess.delete-version.patch.json'), 'utf8')) as RamPolicy

  it('grants only exact-version deletion', () => {
    expect(policy).toMatchObject({ Version: '1' })
    expect(policy.Statement).toHaveLength(1)
    expect(policy.Statement[0]).toMatchObject({
      Effect: 'Allow',
      Action: ['oss:DeleteObjectVersion'],
    })
  })

  it('limits the grant to the Store Nova canary prefix', () => {
    expect(policy.Statement[0]?.Resource).toEqual([
      'acs:oss:*:1600188311395090:codex-image-20260914/merchant-assets/canary/*',
    ])
    expect(JSON.stringify(policy)).not.toContain('merchant-assets/*')
    expect(JSON.stringify(policy)).not.toContain('"oss:*"')
  })
})
