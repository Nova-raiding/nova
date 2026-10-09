import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function diagnose(binding: object | undefined, configuredWorkspace = '') {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-diagnostic-'))
  const path = join(directory, 'binding.json')
  const original = binding ? JSON.stringify(binding) : undefined
  if (original) writeFileSync(path, original)
  try {
    const child = spawnSync(process.execPath, ['apps/plugin/scripts/diagnose-workspace-binding.mjs', '--binding', path,
      '--target-origin', 'https://yxsona.com', '--workspace', 'ws_authorized'], {
      encoding: 'utf8', env: { ...process.env, MERCHANT_WORKSPACE_ID: configuredWorkspace },
    })
    expect(child.status).toBe(0)
    if (original) expect(readFileSync(path, 'utf8')).toBe(original)
    return JSON.parse(child.stdout)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

describe('workspace metadata diagnostic scope', () => {
  it('does not tell an explicitly configured authenticated host to reinstall because of stale fallback metadata', () => {
    const result = diagnose({ schema_version: '2', workspace_id: 'ws_old',
      scope: { api_origin: 'http://127.0.0.1:8787', token_sha256: 'historical-fingerprint' } }, 'ws_authorized')
    expect(result.stale).toBe(true)
    expect(result.reusable).toBe(false)
    expect(result.workspace_resolution).toBe('explicit_environment')
    expect(result.saved_metadata_used_for_workspace).toBe(false)
    expect(result.runtime_authentication).toBe('not_checked')
    expect(result.action).toContain('this alone does not prove that the local plugin login failed')
    expect(result.action).toContain('repeat authenticated login only if that runtime check')
    expect(result.safety).toEqual({ old_identity_reused: false, binding_deleted: false, secrets_read: false })
  })

  it('marks a saved loopback binding for another workspace stale without reusing or deleting its identity', () => {
    const oldBinding = {
      schema_version: '2',
      workspace_id: 'ws_previous',
      scope: {
        api_origin: 'http://127.0.0.1:8787',
        actor_id: 'actor_previous',
        token_sha256: 'historical-fingerprint',
      },
    }
    const result = diagnose(oldBinding)

    expect(result.stale).toBe(true)
    expect(result.reusable).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining([
      'loopback_to_production_origin',
      'workspace_changed',
    ]))
    expect(result.stored).toMatchObject({ workspace_id: 'ws_previous', api_origin: 'http://127.0.0.1:8787' })
    expect(result.target).toMatchObject({ workspace_id: 'ws_authorized', api_origin: 'https://yxsona.com' })
    expect(result.safety).toEqual({ old_identity_reused: false, binding_deleted: false, secrets_read: false })
  })

  it('does not infer missing host authentication from absence of a fallback metadata file', () => {
    const result = diagnose(undefined)
    expect(result.binding_present).toBe(false)
    expect(result.saved_metadata_used_for_workspace).toBe(null)
    expect(result.workspace_resolution).toBe('host_runtime_not_checked')
    expect(result.verification_scope).toBe('saved_workspace_metadata_only')
    expect(result.action).toContain('before deciding whether authenticated installation is required')
  })
})
