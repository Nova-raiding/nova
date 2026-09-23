#!/usr/bin/env node

// Production macOS delivery gate. Signing and notarization credentials stay in
// the release Mac's Keychain; they are never copied into the plugin package.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(pluginRoot, '..', '..')
const manifest = JSON.parse(readFileSync(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const output = resolve(process.argv[2] ?? resolve(repositoryRoot, 'artifacts/local-plugin', `${manifest.id}-${manifest.version}-darwin-${process.arch}.dmg`))
const signer = String(process.env.STORENOVA_MAC_SIGNER_THUMBPRINT ?? '').replace(/\s/gu, '').toUpperCase()
const teamId = String(process.env.STORENOVA_MAC_TEAM_ID ?? '').trim().toUpperCase()
const notaryProfile = String(process.env.STORENOVA_MAC_NOTARY_PROFILE ?? '').trim()

function run(command, args, timeout = 180_000, includeStderr = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr?.trim() || result.error?.message || result.status}`)
  }
  return includeStderr ? `${result.stdout ?? ''}\n${result.stderr ?? ''}` : result.stdout ?? ''
}

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }

function assertDeveloperIdExecutable(path, label) {
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path])
  const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', path], 180_000, true)
  if (!signature.includes(`TeamIdentifier=${teamId}`) ||
      !signature.includes('Authority=Developer ID Application:') ||
      !/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/iu.test(signature) ||
      !/^Timestamp=.+$/mu.test(signature)) {
    throw new Error(`${label} Developer ID signer, team, hardened runtime, or secure timestamp is invalid`)
  }
}

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('macOS arm64 or x64 release host required')
if (!output.endsWith('.dmg')) throw new Error('signed macOS deliverable must be a .dmg file')
if (!/^[0-9A-F]{40}$/u.test(signer)) throw new Error('STORENOVA_MAC_SIGNER_THUMBPRINT must be a Developer ID Application certificate SHA-1')
if (!/^[A-Z0-9]{10}$/u.test(teamId)) throw new Error('STORENOVA_MAC_TEAM_ID is required')
if (!notaryProfile) throw new Error('STORENOVA_MAC_NOTARY_PROFILE must identify a notarytool Keychain profile')
if (existsSync(output) || existsSync(`${output}.sha256`)) throw new Error('release output already exists; choose a new path')

const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
if (!identities.split(/\r?\n/u).some(line => line.includes(signer) && line.includes('Developer ID Application:'))) {
  throw new Error('configured Developer ID Application identity is unavailable on this release Mac')
}

const scratch = mkdtempSync(resolve(tmpdir(), 'storenova-macos-release-'))
try {
  const candidate = resolve(scratch, 'candidate.tar.gz')
  const staged = resolve(scratch, 'payload')
  const image = resolve(scratch, 'signed-notarized.dmg')
  mkdirSync(staged)
  run(process.execPath, [resolve(pluginRoot, 'scripts/package-local-plugin.mjs'), candidate], 300_000)
  run('/usr/bin/tar', ['-xzf', candidate, '-C', staged])

  const helper = resolve(staged, 'mcp/keychain-credential-helper')
  const node = resolve(staged, 'runtime/node')
  const source = resolve(staged, 'mcp/keychain-credential-helper.swift')
  const buildRecord = resolve(staged, 'mcp/keychain-credential-helper.build.json')
  // V8 needs JIT under the hardened runtime. Never inherit the upstream Node
  // development entitlements (including get-task-allow) into our release.
  const nodeEntitlements = resolve(scratch, 'node-entitlements.plist')
  writeFileSync(nodeEntitlements, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>\n')
  run('/usr/bin/codesign', ['--force', '--sign', signer, '--options', 'runtime', '--entitlements', nodeEntitlements, '--timestamp', node])
  assertDeveloperIdExecutable(node, 'Bundled Node')
  if (run(node, ['-p', '`${process.platform}/${process.arch}/${process.versions.node}`']).trim() !== `darwin/${process.arch}/22.16.0`) {
    throw new Error('signed bundled Node fails the architecture/version runtime probe')
  }
  run('/usr/bin/codesign', ['--force', '--sign', signer, '--options', 'runtime', '--timestamp', helper])
  assertDeveloperIdExecutable(helper, 'Keychain helper')
  const record = JSON.parse(readFileSync(buildRecord, 'utf8'))
  if (record.source_sha256 !== sha256(source) || record.platform !== 'darwin' || record.arch !== process.arch) {
    throw new Error('Keychain helper build record does not match the packaged source or release architecture')
  }
  record.binary_sha256 = sha256(helper)
  writeFileSync(buildRecord, `${JSON.stringify(record)}\n`)

  run('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', staged, '-volname', 'Merchant Marketing', '-format', 'UDZO', '-ov', image], 300_000)
  run('/usr/bin/codesign', ['--force', '--sign', signer, '--timestamp', image])
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', image])
  const imageSignature = run('/usr/bin/codesign', ['--display', '--verbose=4', image], 180_000, true)
  if (!imageSignature.includes(`TeamIdentifier=${teamId}`) || !imageSignature.includes('Authority=Developer ID Application:') || !/^Timestamp=.+$/mu.test(imageSignature)) {
    throw new Error('DMG Developer ID signer, team, or secure timestamp is invalid')
  }
  const notarizationOutput = run('/usr/bin/xcrun', ['notarytool', 'submit', image, '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json'], 1_200_000)
  let notarization
  try { notarization = JSON.parse(notarizationOutput.trim()) }
  catch { throw new Error('notarytool did not return valid JSON') }
  if (notarization.status !== 'Accepted' || !notarization.id) throw new Error(`Apple notarization not accepted: ${notarization.status ?? 'unknown'}`)
  run('/usr/bin/xcrun', ['stapler', 'staple', image], 300_000)
  run('/usr/bin/xcrun', ['stapler', 'validate', image])
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', image])

  // Inspect the shipped bytes, not just the pre-image staging directory.
  const mounted = resolve(scratch, 'mounted')
  mkdirSync(mounted)
  run('/usr/bin/hdiutil', ['attach', '-quiet', '-readonly', '-nobrowse', '-mountpoint', mounted, image], 300_000)
  try {
    const shippedNode = resolve(mounted, 'runtime/node')
    const shippedHelper = resolve(mounted, 'mcp/keychain-credential-helper')
    assertDeveloperIdExecutable(shippedNode, 'DMG bundled Node')
    assertDeveloperIdExecutable(shippedHelper, 'DMG Keychain helper')
    if (sha256(shippedNode) !== sha256(node) || sha256(shippedHelper) !== sha256(helper)) {
      throw new Error('DMG executable bytes differ from signed staging payload')
    }
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', shippedNode])
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', shippedHelper])
  } finally {
    run('/usr/bin/hdiutil', ['detach', '-quiet', mounted], 300_000)
  }

  mkdirSync(dirname(output), { recursive: true })
  const digest = sha256(image)
  renameSync(image, output)
  writeFileSync(`${output}.sha256`, `${digest}  ${output.split('/').at(-1)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ ok: true, artifact: output, sha256: digest, platform: 'darwin', architecture: process.arch, signed: true, notarization_id: notarization.id, notarization_status: notarization.status, stapled: true, gatekeeper_assessed: true, ready_to_install: true }, null, 2)}\n`)
} catch (error) {
  // Never leave a partial production artifact after a failed release gate.
  if (existsSync(output)) rmSync(output)
  if (existsSync(`${output}.sha256`)) rmSync(`${output}.sha256`)
  throw error
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
