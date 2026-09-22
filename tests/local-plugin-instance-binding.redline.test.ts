import { describe, expect, it } from 'vitest'
import { verifyLocalPluginInstanceProof } from '../apps/api/src/local-plugin-instance-proof.js'
import { MemoryLocalPluginInstallInstanceRepository } from '../packages/persistence/src/local-plugin-install-instance-repository.js'
// @ts-expect-error Runtime identity module intentionally has no generated declarations.
import { canonicalInstallationTranscript, loadOrCreateInstallationIdentity, publicInstallation, signInstallationTranscript } from '../apps/plugin/mcp/installation-identity.mjs'

const owner = { accountId: 'account_owner', identityId: 'identity_owner', workspaceId: 'ws_bound' }
const identity = (platform: 'macos' | 'windows') => {
  let stored: Record<string, string> | undefined
  return loadOrCreateInstallationIdentity({ platform, load: () => stored, save: (value: Record<string, string>) => { stored = value } })
}

describe('local plugin installation binding security redlines', () => {
  it.each(['macos', 'windows'] as const)('uses two-stage enrollment and consumes a complete P-256 %s proof once', async platform => {
    const repository = new MemoryLocalPluginInstallInstanceRepository(() => Date.parse('2026-09-22T10:00:00.000Z'), 60_000)
    const localIdentity = identity(platform)
    const published = publicInstallation(localIdentity)
    const enrolled = await repository.register({ platform, publicKey: published.installation_public_key_spki })
    expect(enrolled.instance).not.toHaveProperty('accountId')
    expect(enrolled.instance).not.toHaveProperty('workspaceId')
    await repository.pair({ ...owner, instanceId: enrolled.instance.id, pairingToken: enrolled.pairingToken })
    await expect(repository.pair({ ...owner, instanceId: enrolled.instance.id, pairingToken: enrolled.pairingToken })).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_INSTALL_INSTANCE_INVALID' })
    const requestId = 'request_1234567890abcdef'
    const challenge = await repository.issueChallenge({ ...owner, instanceId: enrolled.instance.id, requestId })
    const transcript = { method: 'POST', path: '/v1/auth/local-plugin/authorize', apiOrigin: 'https://yxsona.com', requestId,
      challengeId: challenge.id, accountId: owner.accountId, workspaceId: owner.workspaceId, installationId: published.installation_id,
      keyId: published.key_id, platform, pkceChallenge: 'c'.repeat(43), redirectUri: 'http://127.0.0.1:49191/merchant-mcp-callback',
      clientNonce: 'client_nonce_1234567890', serverNonce: challenge.nonce, issuedAt: challenge.createdAt, expiresAt: challenge.expiresAt } as const
    const signature = signInstallationTranscript(localIdentity, transcript)
    expect(verifyLocalPluginInstanceProof({ ...transcript, publicKeySpki: published.installation_public_key_spki, signature })).toBe(true)
    const proof = { ...owner, id: challenge.id, instanceId: enrolled.instance.id, requestId, nonce: challenge.nonce,
      issuedAt: challenge.createdAt, expiresAt: challenge.expiresAt, message: canonicalInstallationTranscript(transcript).toString('utf8'), signature }
    await expect(repository.verifyAndConsumeChallenge(proof)).resolves.toMatchObject({ id: enrolled.instance.id, platform })
    await expect(repository.verifyAndConsumeChallenge(proof)).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_INSTALL_INSTANCE_INVALID' })
  })

  it('rejects replacement keys and every security-relevant transcript mutation', () => {
    const original = identity('windows')
    const replacement = identity('windows')
    const published = publicInstallation(original)
    const transcript = { method: 'POST', path: '/v1/auth/local-plugin/authorize', apiOrigin: 'https://yxsona.com',
      requestId: 'request_abcdef1234567890', challengeId: 'challenge_abcdef123456', accountId: owner.accountId,
      workspaceId: owner.workspaceId, installationId: published.installation_id, keyId: published.key_id, platform: 'windows',
      pkceChallenge: 'd'.repeat(43), redirectUri: 'http://127.0.0.1:49191/merchant-mcp-callback', clientNonce: 'client_nonce_abcdef1234',
      serverNonce: 'server_nonce_abcdef1234', issuedAt: '2026-09-22T10:00:00.000Z', expiresAt: '2026-09-22T10:02:00.000Z' } as const
    const signature = signInstallationTranscript(original, transcript)
    const verify = (changed: Record<string, string>) => verifyLocalPluginInstanceProof({ ...transcript, ...changed,
      publicKeySpki: published.installation_public_key_spki, signature })
    const mutations: Array<Record<string, string>> = [{ apiOrigin: 'https://attacker.example' }, { requestId: 'request_other1234567890' },
      { workspaceId: 'ws_other' }, { pkceChallenge: 'e'.repeat(43) }, { serverNonce: 'server_nonce_other12345' },
      { installationId: replacement.installation_id }, { keyId: replacement.key_id },
      { redirectUri: 'http://127.0.0.1:49192/merchant-mcp-callback' }]
    for (const changed of mutations) expect(verify(changed)).toBe(false)
    expect(verifyLocalPluginInstanceProof({ ...transcript, publicKeySpki: publicInstallation(replacement).installation_public_key_spki, signature })).toBe(false)
  })

  it('rejects expired challenges before accepting an otherwise plausible proof', async () => {
    let now = 10_000
    const repository = new MemoryLocalPluginInstallInstanceRepository(() => now, 10)
    const localIdentity = identity('macos')
    const published = publicInstallation(localIdentity)
    const enrolled = await repository.register({ platform: 'macos', publicKey: published.installation_public_key_spki })
    await repository.pair({ ...owner, instanceId: enrolled.instance.id, pairingToken: enrolled.pairingToken })
    const requestId = 'request_expired123456789'
    const challenge = await repository.issueChallenge({ ...owner, instanceId: enrolled.instance.id, requestId })
    now = 10_011
    await expect(repository.verifyAndConsumeChallenge({ ...owner, id: challenge.id, instanceId: enrolled.instance.id, requestId,
      nonce: challenge.nonce, issuedAt: challenge.createdAt, expiresAt: challenge.expiresAt,
      message: 'valid-looking-message', signature: 'invalid-but-never-reached' })).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_INSTALL_INSTANCE_INVALID' })
  })
})
