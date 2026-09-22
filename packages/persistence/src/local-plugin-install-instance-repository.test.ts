import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryLocalPluginInstallInstanceRepository } from './local-plugin-install-instance-repository.js'

const owner = { accountId: 'account-a', identityId: 'identity-a', workspaceId: 'workspace-a' }
describe('local plugin install instance repository', () => {
  it('pairs once and consumes a request-bound P-256 challenge once', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    const repository = new MemoryLocalPluginInstallInstanceRepository()
    const registration = await repository.register({ platform: 'windows', publicKey })
    expect(registration.instance.accountId).toBeUndefined()
    const instance = await repository.pair({ ...owner, instanceId: registration.instance.id, pairingToken: registration.pairingToken })
    await expect(repository.pair({ ...owner, instanceId: instance.id, pairingToken: registration.pairingToken })).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_INSTALL_INSTANCE_INVALID' })
    const challenge = await repository.issueChallenge({ ...owner, instanceId: instance.id, requestId: 'request-a' })
    const message = `store-nova-local-plugin-v1\n${challenge.nonce}\nrequest-a`
    const signature = sign('sha256', Buffer.from(message), pair.privateKey).toString('base64url')
    const proof = { ...owner, id: challenge.id, instanceId: instance.id, requestId: 'request-a', nonce: challenge.nonce, issuedAt: challenge.createdAt, expiresAt: challenge.expiresAt, message, signature }
    await expect(repository.verifyAndConsumeChallenge(proof)).resolves.toMatchObject({ id: instance.id })
    await expect(repository.verifyAndConsumeChallenge(proof)).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_INSTALL_INSTANCE_INVALID' })
  })

  it('fails closed across owners and request bindings', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const repository = new MemoryLocalPluginInstallInstanceRepository()
    const registration = await repository.register({ platform: 'macos', publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') })
    await repository.pair({ ...owner, instanceId: registration.instance.id, pairingToken: registration.pairingToken })
    await expect(repository.issueChallenge({ ...owner, accountId: 'account-b', instanceId: registration.instance.id, requestId: 'request-a' })).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_INSTALL_INSTANCE_INVALID' })
  })
})
