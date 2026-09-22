import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { localPluginInstanceProofMessage, verifyLocalPluginInstanceProof } from '../../api/src/local-plugin-instance-proof.js'
// @ts-expect-error Runtime module intentionally has no TS build step.
import { canonicalInstallationTranscript, loadOrCreateInstallationIdentity, publicInstallation, signInstallationTranscript } from './installation-identity.mjs'

describe('installation identity', () => {
  it('persists one P-256 identity through an injected OS secure store and signs challenges', () => {
    let stored: Record<string, string> | undefined
    const first = loadOrCreateInstallationIdentity({ platform: 'windows', load: () => stored, save: (value: Record<string, string>) => { stored = value } })
    const second = loadOrCreateInstallationIdentity({ platform: 'windows', load: () => stored, save: () => { throw new Error('must not rotate') } })
    expect(second).toEqual(first)
    expect(publicInstallation(first)).toEqual({ installation_id: first.installation_id,
      key_id: first.key_id, installation_public_key_spki: first.installation_public_key_spki, platform: 'windows' })
    const transcript = { method: 'POST', path: '/v1/auth/local-plugin/authorize', apiOrigin: 'https://yxsona.com',
      requestId: 'request_1234567890abcdef', challengeId: 'challenge-id-123456', accountId: 'account-123', workspaceId: 'ws_test',
      installationId: first.installation_id, keyId: first.key_id, platform: 'windows', pkceChallenge: 'challenge_1234567890abcdef',
      redirectUri: 'http://127.0.0.1:12345/merchant-mcp-callback', clientNonce: 'client_nonce_1234567890',
      serverNonce: 'server_nonce_1234567890', issuedAt: '2026-09-22T10:00:00.000Z', expiresAt: '2026-09-22T10:05:00.000Z' } as const
    const signature = signInstallationTranscript(first, transcript)
    const publicKey = createPublicKey({ key: Buffer.from(first.installation_public_key_spki, 'base64url'), format: 'der', type: 'spki' })
    expect(verify('sha256', canonicalInstallationTranscript(transcript), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
    expect(canonicalInstallationTranscript(transcript)).toEqual(localPluginInstanceProofMessage(transcript))
    expect(verifyLocalPluginInstanceProof({ ...transcript, publicKeySpki: first.installation_public_key_spki, signature })).toBe(true)
    expect(verify('sha256', canonicalInstallationTranscript({ ...transcript, workspaceId: 'ws_other' }), publicKey,
      Buffer.from(signature, 'base64url'))).toBe(false)
  })
})
