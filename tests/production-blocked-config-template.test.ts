import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const gate = resolve('infra/scripts/validate-production-config.sh')
const renderer = resolve('infra/scripts/render-production-config-from-env.mjs')
const template = resolve('infra/config/production.blocked.example.yaml')

function parseTopLevel(source: string): Record<string, unknown> {
  return Object.fromEntries(source.split(/\r?\n/).flatMap(line => {
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (!match) return []
    return [[match[1], match[2] === 'null' ? null : match[2]]]
  }))
}

function requiredKeys(): string[] {
  const source = readFileSync(gate, 'utf8')
  const base = source.match(/^required_keys='([^']+)'/m)?.[1]?.split(/\s+/) ?? []
  return [...new Set([
    ...base,
    'mcp_authorization_mode',
    'durable_platform_assignments_required',
    'platform_operations_mode',
    'app_base_url',
    'ops_base_url',
    'mcp_base_url',
    'asset_scan_trusted_public_keys_ref',
    'OPS_AUTH_MODE',
    'object_storage_sse_mode',
    'release_id',
  ])]
}

describe('blocked production configuration template', () => {
  it('declares every required key exactly once with no invented value', () => {
    const source = readFileSync(template, 'utf8')
    const document = parseTopLevel(source)
    expect(document.configuration_status).toBe('BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS')
    for (const key of requiredKeys()) {
      expect(Object.prototype.hasOwnProperty.call(document, key), key).toBe(true)
      expect(document[key], key).toBeNull()
      expect(source.match(new RegExp(`^${key}:`, 'gm')), key).toHaveLength(1)
    }
    expect(Object.keys(document).sort()).toEqual(['configuration_status', ...requiredKeys()].sort())
  })

  it('remains fail-closed because real production values are absent', () => {
    const result = spawnSync('sh', [gate, template], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('required production config value is missing')
    expect(result.stderr).not.toContain('required production config key is missing')
  })

  it('matches the renderer output for an empty deployment environment', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'blocked-production-config-'))
    try {
      const source = resolve(directory, 'empty.env')
      const output = resolve(directory, 'production.yaml')
      writeFileSync(source, '')
      const result = spawnSync(process.execPath, [renderer, source, output, gate], { encoding: 'utf8' })
      expect(result.status).toBe(2)
      const rendered = parseTopLevel(readFileSync(output, 'utf8'))
      const checkedIn = parseTopLevel(readFileSync(template, 'utf8'))
      expect(rendered).toEqual(checkedIn)
      expect(JSON.parse(result.stdout).missingKeys.sort()).toEqual(requiredKeys().sort())
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
