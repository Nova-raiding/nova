import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'

const fail = () => { throw new Error('LOCAL_PLUGIN_INSTALLATION_IDENTITY_INVALID') }
const encode = value => Buffer.from(value).toString('base64url')

/** Secure-store callbacks must persist in Keychain or Credential Manager, never a plaintext file. */
export function loadOrCreateInstallationIdentity({ platform, load, save }) {
  if (!['macos', 'windows'].includes(platform) || typeof load !== 'function' || typeof save !== 'function') fail()
  const existing = load()
  if (existing !== undefined) {
    if (!existing || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(existing.installation_id)
      || !/^[A-Za-z0-9_-]{43}$/u.test(existing.key_id)
      || !/^[A-Za-z0-9_-]{40,256}$/u.test(existing.installation_public_key_spki)
      || !/^[A-Za-z0-9_-]{40,512}$/u.test(existing.installation_private_key_pkcs8) || existing.platform !== platform) fail()
    return existing
  }
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' })
  const identity = { schema_version: '1', installation_id: randomUUID(), platform,
    key_id: encode(createHash('sha256').update(publicDer).digest()), installation_public_key_spki: encode(publicDer),
    installation_private_key_pkcs8: encode(pair.privateKey.export({ type: 'pkcs8', format: 'der' })) }
  save(identity)
  return identity
}

export function publicInstallation(identity) {
  return { installation_id: identity.installation_id, key_id: identity.key_id,
    installation_public_key_spki: identity.installation_public_key_spki, platform: identity.platform }
}

export function canonicalInstallationTranscript(input) {
  const ownerHash = createHash('sha256').update(`${input?.accountId}\n${input?.workspaceId}`, 'utf8').digest('base64url')
  const fields = ['store-nova.local-plugin.installation-proof', '1', input?.method, input?.path, input?.apiOrigin,
    input?.requestId, input?.challengeId, ownerHash, input?.installationId, input?.keyId, input?.platform,
    input?.pkceChallenge, input?.redirectUri, input?.clientNonce, input?.serverNonce, input?.issuedAt, input?.expiresAt]
  if (input?.method !== 'POST' || input?.path !== '/v1/auth/local-plugin/authorize'
    || fields.some(value => typeof value !== 'string' || !value || value.includes('\n') || value.includes('\r'))) fail()
  return Buffer.from(fields.join('\n'), 'utf8')
}

export function signInstallationTranscript(identity, input) {
  if (input?.installationId !== identity?.installation_id || input?.keyId !== identity?.key_id || input?.platform !== identity?.platform) fail()
  const key = { key: Buffer.from(identity.installation_private_key_pkcs8, 'base64url'), format: 'der', type: 'pkcs8' }
  return encode(sign('sha256', canonicalInstallationTranscript(input), key))
}
