import { describe, expect, it, vi } from 'vitest'
import { ConnectorRuntime } from './connector-runtime.js'

describe('ConnectorRuntime media cleanup recovery', () => {
  it('persists an orphan when discard throws and preserves the publish rejection', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true })
    const connector = runtime.connector('jd') as any
    const media = {
      visualRef: 'visual_discard_error',
      role: 'main' as const,
      mimeType: 'image/png',
      sha256: 'e'.repeat(64),
      bytes: new Uint8Array([5]),
      idempotencyKey: 'job_discard_error:media:visual_discard_error',
    }
    const receipt = {
      platform: 'jd' as const,
      visualRef: media.visualRef,
      role: media.role,
      mediaId: 'remote_discard_error',
      sha256: media.sha256,
      simulated: false,
    }
    const transitions: Array<{ state: string; reason?: string }> = []
    connector.uploadMedia = vi.fn(async () => receipt)
    connector.validateWrite = () => [{ field: 'title', code: 'INVALID_VALUE', message: 'preflight rejected', severity: 'error' }]
    connector.discardMedia = vi.fn(async () => { throw new Error('provider secret must not escape') })
    const transition = vi.fn(async (value: { state: string; reason?: string }) => { transitions.push(value) })

    await expect(runtime.executePublish({
      platform: 'jd',
      context: { workspaceId: 'ws_discard_error', accountId: 'acct_discard_error' },
      fields: {},
      idempotencyKey: 'publish_discard_error',
      media: [media],
      mediaLifecycle: { transition },
    })).rejects.toThrow('preflight rejected')

    expect(connector.discardMedia).toHaveBeenCalledOnce()
    expect(transitions.map(item => item.state)).toEqual(['intent', 'uploaded', 'orphaned', 'orphaned'])
    expect(transitions[2]).toMatchObject({ state: 'orphaned', reason: 'prewrite_cleanup_pending_manual_recovery_required' })
    expect(transitions.at(-1)).toMatchObject({ state: 'orphaned', reason: 'discard_adapter_failed_manual_recovery_required' })
    expect(JSON.stringify(transitions)).not.toContain('provider secret')
  })
})
