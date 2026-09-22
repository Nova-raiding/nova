import { createHash, createPublicKey, verify } from 'node:crypto'

export const LOCAL_PLUGIN_INSTANCE_PROOF_DOMAIN = 'store-nova.local-plugin.installation-proof'
export const LOCAL_PLUGIN_INSTANCE_PROOF_VERSION = '1'

export type LocalPluginInstanceProofTranscript = {
  method: 'POST'
  path: '/v1/auth/local-plugin/authorize'
  apiOrigin: string
  requestId: string
  challengeId: string
  accountId: string
  workspaceId: string
  installationId: string
  keyId: string
  platform: 'macos' | 'windows'
  pkceChallenge: string
  redirectUri: string
  clientNonce: string
  serverNonce: string
  issuedAt: string
  expiresAt: string
}

const b64 = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('LOCAL_PLUGIN_INSTANCE_PROOF_INVALID')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('LOCAL_PLUGIN_INSTANCE_PROOF_INVALID')
  return bytes
}

export function localPluginOwnerHash(accountId: string, workspaceId: string) {
  return createHash('sha256').update(`${accountId}\n${workspaceId}`, 'utf8').digest('base64url')
}

export function localPluginInstanceProofMessage(input: LocalPluginInstanceProofTranscript) {
  const fields = [
    LOCAL_PLUGIN_INSTANCE_PROOF_DOMAIN, LOCAL_PLUGIN_INSTANCE_PROOF_VERSION,
    input.method, input.path, input.apiOrigin, input.requestId, input.challengeId,
    localPluginOwnerHash(input.accountId, input.workspaceId), input.installationId,
    input.keyId, input.platform, input.pkceChallenge, input.redirectUri,
    input.clientNonce, input.serverNonce, input.issuedAt, input.expiresAt,
  ]
  if (fields.some(value => !value || value.includes('\n') || value.includes('\r'))) throw new Error('LOCAL_PLUGIN_INSTANCE_PROOF_INVALID')
  return Buffer.from(fields.join('\n'), 'utf8')
}

export function p256SpkiFingerprint(publicKeySpki: string) {
  const der = b64(publicKeySpki)
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('LOCAL_PLUGIN_INSTANCE_KEY_INVALID')
  return createHash('sha256').update(der).digest('base64url')
}

export function verifyLocalPluginInstanceProof(input: LocalPluginInstanceProofTranscript & { publicKeySpki: string; signature: string }) {
  try {
    const der = b64(input.publicKeySpki)
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false
    return verify('sha256', localPluginInstanceProofMessage(input), key, b64(input.signature))
  } catch { return false }
}
