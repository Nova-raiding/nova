import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type RenderedProductionConfig = {
  schema_version: '1'
  source: { release_id: string; git_sha: string; source_digest: string }
  secrets: { provider: string; references: Record<string, string> }
  provider: { model_relay_base_url: string; model_relay_api_key_ref: string; payment_provider: string }
  database: { url_ref: string; pooler: string }
  backup: { provider: string; bucket: string; retention_days: number; kms_key_ref: string }
}

const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function completeConfig(overrides: Partial<RenderedProductionConfig> = {}): RenderedProductionConfig {
  return {
    schema_version: '1',
    source: { release_id: 'merchant-release-2026-09-01', git_sha: 'a'.repeat(40), source_digest: sha256('source-manifest') },
    secrets: {
      provider: 'vault',
      references: {
        model_relay_api_key: 'vault://merchant-model/relay-api-key',
        payment_provider_api_key: 'vault://merchant-payment/provider-api-key',
        database_url: 'vault://merchant/database-url',
        backup_kms_key: 'vault://merchant/backup-kms-key',
      },
    },
    provider: {
      model_relay_base_url: 'https://relay.production.example/v1',
      model_relay_api_key_ref: 'vault://merchant-model/relay-api-key',
      payment_provider: 'alipay,wechat',
    },
    database: { url_ref: 'vault://merchant/database-url', pooler: 'pgbouncer.production.example' },
    backup: { provider: 's3', bucket: 'merchant-production-backups', retention_days: 30, kms_key_ref: 'vault://merchant/backup-kms-key' },
    ...overrides,
  }
}

function validateRenderedConfig(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['rendered production config must be an object']
  const config = value as Record<string, unknown>
  if (config.schema_version !== '1') errors.push('schema_version must be 1')

  const required = [
    ['source.release_id', config.source && (config.source as Record<string, unknown>).release_id],
    ['source.git_sha', config.source && (config.source as Record<string, unknown>).git_sha],
    ['source.source_digest', config.source && (config.source as Record<string, unknown>).source_digest],
    ['secrets.provider', config.secrets && (config.secrets as Record<string, unknown>).provider],
    ['provider.model_relay_base_url', config.provider && (config.provider as Record<string, unknown>).model_relay_base_url],
    ['provider.model_relay_api_key_ref', config.provider && (config.provider as Record<string, unknown>).model_relay_api_key_ref],
    ['provider.payment_provider', config.provider && (config.provider as Record<string, unknown>).payment_provider],
    ['database.url_ref', config.database && (config.database as Record<string, unknown>).url_ref],
    ['database.pooler', config.database && (config.database as Record<string, unknown>).pooler],
    ['backup.provider', config.backup && (config.backup as Record<string, unknown>).provider],
    ['backup.bucket', config.backup && (config.backup as Record<string, unknown>).bucket],
    ['backup.retention_days', config.backup && (config.backup as Record<string, unknown>).retention_days],
    ['backup.kms_key_ref', config.backup && (config.backup as Record<string, unknown>).kms_key_ref],
  ] as const
  for (const [path, field] of required) {
    if (field === undefined || field === null || field === '') errors.push(`${path} is required`)
  }

  const source = config.source as Record<string, unknown> | undefined
  if (typeof source?.source_digest === 'string' && !/^sha256:[a-f0-9]{64}$/u.test(source.source_digest)) errors.push('source.source_digest must be a SHA-256 digest')
  const secretRefs = (config.secrets as Record<string, unknown> | undefined)?.references
  if (!secretRefs || typeof secretRefs !== 'object' || Array.isArray(secretRefs)) errors.push('secrets.references is required')
  else for (const [name, reference] of Object.entries(secretRefs)) {
    if (typeof reference !== 'string' || !/^(?:vault|secret):\/\/[A-Za-z0-9._/-]+$/u.test(reference)) errors.push(`secrets.references.${name} must be a managed secret reference`)
  }
  return errors
}

function runSourceManifest(profile: 'api' | 'worker', sourceRoot: string, outputPrefix: string) {
  return execFileSync('node', ['infra/scripts/generate-container-source-manifest.mjs', 'generate', profile, sourceRoot, `${outputPrefix}.manifest`, `${outputPrefix}.manifest.sha256`], { encoding: 'utf8', stdio: 'pipe' })
}

describe('rendered production config evidence contract', () => {
  it('requires source identity, digest, secret references, provider/model, database, and backup sections', () => {
    const complete = completeConfig()
    expect(validateRenderedConfig(complete)).toEqual([])

    for (const section of ['source', 'secrets', 'provider', 'database', 'backup'] as const) {
      const missing = { ...complete, [section]: undefined }
      expect(validateRenderedConfig(missing)).toEqual(expect.arrayContaining([expect.stringContaining(`${section}.`)]))
    }
    const withoutRelay = completeConfig({ provider: { ...complete.provider, model_relay_base_url: '' } })
    expect(validateRenderedConfig(withoutRelay)).toContain('provider.model_relay_base_url is required')
    const withoutDatabase = completeConfig({ database: { ...complete.database, url_ref: '' } })
    expect(validateRenderedConfig(withoutDatabase)).toContain('database.url_ref is required')
    const withoutBackup = completeConfig({ backup: { ...complete.backup, kms_key_ref: '' } })
    expect(validateRenderedConfig(withoutBackup)).toContain('backup.kms_key_ref is required')
  })

  it('rejects malformed source digests and non-managed secret references without echoing values', () => {
    const malformed = completeConfig({ source: { ...completeConfig().source, source_digest: 'not-a-digest' } })
    expect(validateRenderedConfig(malformed)).toContain('source.source_digest must be a SHA-256 digest')
    const unsafe = completeConfig({ secrets: { ...completeConfig().secrets, references: { leaked: 'super-secret-value' } } })
    const errors = validateRenderedConfig(unsafe)
    expect(errors).toContain('secrets.references.leaked must be a managed secret reference')
    expect(errors.join('\n')).not.toContain('super-secret-value')
  })

  it('binds generated API and worker source manifests to an exact digest file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rendered-production-source-contract-'))
    const apiOutput = join(directory, 'api')
    const workerOutput = join(directory, 'worker')
    runSourceManifest('api', process.cwd(), apiOutput)
    runSourceManifest('worker', process.cwd(), workerOutput)
    for (const prefix of [apiOutput, workerOutput]) {
      const manifest = readFileSync(`${prefix}.manifest`, 'utf8')
      const digest = readFileSync(`${prefix}.manifest.sha256`, 'utf8').trim()
      expect(digest).toBe(sha256(manifest))
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
      const tampered = `${manifest}\n tampered`
      writeFileSync(`${prefix}.tampered.manifest`, tampered)
      expect(sha256(tampered)).not.toBe(digest)
      expect(() => execFileSync('node', ['infra/scripts/generate-container-source-manifest.mjs', 'verify', prefix === apiOutput ? 'api' : 'worker', `${prefix}.tampered.manifest`, `${prefix}.manifest.sha256`], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/digest|mismatch|malformed/u)
    }
  })
})
