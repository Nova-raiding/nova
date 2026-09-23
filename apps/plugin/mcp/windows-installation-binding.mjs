import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { loadOrCreateInstallationIdentity, publicInstallation } from './installation-identity.mjs'

const fail = () => { throw new Error('LOCAL_PLUGIN_WINDOWS_INSTALLATION_BINDING_INVALID') }
const b64 = value => Buffer.from(value).toString('base64url')
const cleanHex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9A-Fa-f]{${length}}$`, 'u').test(value)

function canonical(record) {
  const fields = ['store-nova.windows-package-binding', '1', record.installation_id, record.key_id,
    record.platform, record.package_sha256, record.plugin_version, record.signer_thumbprint, record.previous_package_sha256,
    String(record.sequence)]
  if (fields.some(value => typeof value !== 'string' || !value || /[\r\n]/u.test(value))) fail()
  return Buffer.from(fields.join('\n'), 'utf8')
}

export function verifyWindowsInstallationBinding(record) {
  try {
    if (record?.schema_version !== '1' || record.platform !== 'windows' || !/^[0-9a-f-]{36}$/iu.test(record.installation_id)
      || !/^[A-Za-z0-9_-]{43}$/u.test(record.key_id) || !cleanHex(record.package_sha256, 64)
      || !/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(record.plugin_version)
      || !/^[0-9A-F]{40,64}$/u.test(record.signer_thumbprint)
      || !(record.previous_package_sha256 === 'GENESIS' || cleanHex(record.previous_package_sha256, 64))
      || !Number.isSafeInteger(record.sequence) || record.sequence < 1
      || !/^[A-Za-z0-9_-]{40,256}$/u.test(record.installation_public_key_spki)
      || !/^[A-Za-z0-9_-]{80,128}$/u.test(record.signature)) return false
    const publicKey = createPublicKey({ key: Buffer.from(record.installation_public_key_spki, 'base64url'), format: 'der', type: 'spki' })
    const fingerprint = b64(createHash('sha256').update(Buffer.from(record.installation_public_key_spki, 'base64url')).digest())
    return fingerprint === record.key_id && verify('sha256', canonical(record), publicKey, Buffer.from(record.signature, 'base64url'))
  } catch { return false }
}

/** Prepare is side-effect free apart from first-use key creation. Commit only after the upgrade succeeds. */
export function prepareWindowsInstallationBinding({ identityStore, receiptStore, packageSha256, pluginVersion, signerThumbprint }) {
  if (!identityStore || !receiptStore || !cleanHex(packageSha256, 64)
    || !/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(pluginVersion ?? '')
    || !/^[0-9A-F]{40,64}$/u.test(signerThumbprint ?? '')) fail()
  const previous = receiptStore.load()
  // A committed receipt proves this is an upgrade. Never rotate the key merely
  // because Credential Manager cannot read the corresponding identity.
  const existingIdentity = identityStore.load()
  if (previous !== undefined && existingIdentity === undefined) fail()
  const identity = loadOrCreateInstallationIdentity({ platform: 'windows', load: () => existingIdentity, save: identityStore.save })
  if (previous !== undefined && (!verifyWindowsInstallationBinding(previous)
    || previous.installation_id !== identity.installation_id || previous.key_id !== identity.key_id)) fail()
  const publicIdentity = publicInstallation(identity)
  const unsigned = { schema_version: '1', ...publicIdentity, package_sha256: packageSha256.toUpperCase(),
    plugin_version: pluginVersion, signer_thumbprint: signerThumbprint,
    previous_package_sha256: previous?.package_sha256 ?? 'GENESIS', sequence: (previous?.sequence ?? 0) + 1 }
  const privateKey = createPrivateKey({ key: Buffer.from(identity.installation_private_key_pkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
  const candidate = { ...unsigned, signature: b64(sign('sha256', canonical(unsigned), privateKey)) }
  if (!verifyWindowsInstallationBinding(candidate)) fail()
  let committed = false
  return {
    candidate,
    previous,
    commit() {
      if (committed) fail()
      const current = receiptStore.load()
      if (JSON.stringify(current) !== JSON.stringify(previous)) fail()
      receiptStore.save(candidate)
      committed = true
      return candidate
    },
  }
}

export function commitPreparedWindowsInstallationBinding({ identityStore, receiptStore, candidate }) {
  const identity = identityStore.load()
  const previous = receiptStore.load()
  if (!identity || !verifyWindowsInstallationBinding(candidate)
    || candidate.installation_id !== identity.installation_id || candidate.key_id !== identity.key_id
    || candidate.previous_package_sha256 !== (previous?.package_sha256 ?? 'GENESIS')
    || candidate.sequence !== (previous?.sequence ?? 0) + 1
    || previous !== undefined && !verifyWindowsInstallationBinding(previous)) fail()
  receiptStore.save(candidate)
  return candidate
}
