export const PRODUCTION_PROFILE = 'production'
export const QA_BROKER_PROFILE = 'qa-broker'
export const QA_BROKER_PATH = 'mcp/keychain-broker.mjs'

const profiles = new Set([PRODUCTION_PROFILE, QA_BROKER_PROFILE])

export function parsePackageCliArgs(args) {
  let output
  let windowsHelperDirectory
  let ciTestCertificate = false
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--profile') {
      const profile = args[index + 1]
      if (!profile || profile.startsWith('--')) throw new Error('local plugin package profile value is required')
      index += 1
      continue
    }
    if (value === '--windows-helper-dir') {
      const directory = args[index + 1]
      if (!directory || directory.startsWith('--')) throw new Error('Windows helper directory value is required')
      if (windowsHelperDirectory !== undefined) throw new Error('Windows helper directory may be specified only once')
      windowsHelperDirectory = directory
      index += 1
      continue
    }
    if (value === '--ci-test-certificate') {
      if (ciTestCertificate) throw new Error('CI test-certificate mode may be specified only once')
      ciTestCertificate = true
      continue
    }
    if (value.startsWith('--')) throw new Error(`unsupported local plugin package argument: ${value}`)
    if (output !== undefined) throw new Error('local plugin package output may be specified only once')
    output = value
  }
  return { output, windowsHelperDirectory, ciTestCertificate }
}

export function readPackageProfile(args, env = process.env) {
  const indexes = args.flatMap((value, index) => value === '--profile' ? [index] : [])
  if (indexes.length > 1) throw new Error('local plugin package profile may be specified only once')
  const argumentValue = indexes.length === 1 ? args[indexes[0] + 1] : undefined
  if (indexes.length === 1 && (!argumentValue || argumentValue.startsWith('--'))) {
    throw new Error('local plugin package profile value is required')
  }
  const environmentValue = env.STORENOVA_PLUGIN_PACKAGE_PROFILE?.trim()
  if (argumentValue && environmentValue && argumentValue !== environmentValue) {
    throw new Error('local plugin package profile argument and environment disagree')
  }
  const profile = argumentValue ?? environmentValue ?? PRODUCTION_PROFILE
  if (!profiles.has(profile)) throw new Error(`unsupported local plugin package profile: ${profile}`)
  return profile
}

export function packageProfileManifest(profile) {
  if (!profiles.has(profile)) throw new Error(`unsupported local plugin package profile: ${profile}`)
  const qaBroker = profile === QA_BROKER_PROFILE
  return {
    schema_version: '1',
    profile,
    qa_only: qaBroker,
    release_eligible: !qaBroker,
    credential_broker: {
      path: QA_BROKER_PATH,
      included: qaBroker,
      authenticated_peer_identity: false,
      release_eligible: false,
    },
  }
}

export function assertReleaseEligiblePackageProfile(value) {
  if (value?.schema_version !== '1' || value.profile !== PRODUCTION_PROFILE
      || value.qa_only !== false || value.release_eligible !== true
      || value.credential_broker?.included !== false) {
    throw new Error('production release requires a release-eligible production bundle profile')
  }
  return value
}

export function profileSourceEntries(profile, sourceExists) {
  const manifest = packageProfileManifest(profile)
  if (!manifest.credential_broker.included) return []
  if (!sourceExists(QA_BROKER_PATH)) throw new Error(`QA broker package input is missing: ${QA_BROKER_PATH}`)
  return [QA_BROKER_PATH]
}

export function assertPackageProfileEntries(profile, entries) {
  const manifest = packageProfileManifest(profile)
  const occurrences = entries.filter(entry => entry === QA_BROKER_PATH).length
  if (manifest.credential_broker.included && occurrences !== 1) {
    throw new Error('QA broker package must contain exactly one credential broker entry')
  }
  if (!manifest.credential_broker.included && occurrences !== 0) {
    throw new Error('production package must not contain the unauthenticated credential broker')
  }
  if (entries.filter(entry => entry === 'bundle-profile.json').length !== 1) {
    throw new Error('local plugin package must contain exactly one bundle profile manifest')
  }
  return manifest
}
