#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createWindowsInstallationBindingStore, createWindowsInstallationIdentityStore } from '../mcp/windows-credential.mjs'
import { commitPreparedWindowsInstallationBinding, prepareWindowsInstallationBinding } from '../mcp/windows-installation-binding.mjs'

const fail = () => { throw new Error('LOCAL_PLUGIN_WINDOWS_INSTALLATION_BINDING_FAILED') }
if (process.platform !== 'win32') fail()
const [mode, ...args] = process.argv.slice(2)
const values = new Map()
for (let index = 0; index < args.length; index += 2) {
  if (!args[index]?.startsWith('--') || !args[index + 1]) fail()
  values.set(args[index].slice(2), args[index + 1])
}
const identityStore = createWindowsInstallationIdentityStore()
const receiptStore = createWindowsInstallationBindingStore()
try {
  if (mode === 'prepare') {
    const prepared = prepareWindowsInstallationBinding({ identityStore, receiptStore,
      packageSha256: values.get('package-sha256'), pluginVersion: values.get('plugin-version'),
      signerThumbprint: values.get('signer-thumbprint') })
    process.stdout.write(`${JSON.stringify(prepared.candidate)}\n`)
  } else if (mode === 'commit' && args.length === 0) {
    const input = readFileSync(0, 'utf8')
    if (Buffer.byteLength(input) > 16 * 1024) fail()
    const committed = commitPreparedWindowsInstallationBinding({ identityStore, receiptStore, candidate: JSON.parse(input) })
    process.stdout.write(`${JSON.stringify({ ok: true, installation_id: committed.installation_id,
      package_sha256: committed.package_sha256, sequence: committed.sequence })}\n`)
  } else fail()
} catch { process.stderr.write('LOCAL_PLUGIN_WINDOWS_INSTALLATION_BINDING_FAILED\n'); process.exitCode = 78 }
