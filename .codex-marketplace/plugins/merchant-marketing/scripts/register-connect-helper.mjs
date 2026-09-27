#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const fail = () => { throw new Error('LOCAL_PLUGIN_CONNECT_HELPER_UNTRUSTED') }

/** Registration runs only after a signed and notarized package was installed. */
export function registerConnectHelper({ pluginRoot, run = spawnSync }) {
  if (process.platform !== 'darwin') fail()
  const status = JSON.parse(readFileSync(resolve(pluginRoot, 'bundle-status.json'), 'utf8'))
  const app = resolve(pluginRoot, 'Store Nova Connect.app')
  if (status?.release_status !== 'signed_notarized' || status.ready_to_install !== true
    || status.source_dirty !== false || !/^[A-Z0-9]{10}$/u.test(status.mac_team_id ?? '')
    || !/^[0-9A-F]{40}$/u.test(status.mac_signer_thumbprint ?? '')
    || !existsSync(resolve(app, 'Contents/MacOS/store-nova-connect'))) fail()
  try {
    const execute = (command, args) => {
      const result = run(command, args, { encoding: 'utf8', timeout: 30_000 })
      if (result.error || result.status !== 0) fail()
      return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    }
    execute('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', app])
    const details = execute('/usr/bin/codesign', ['--display', '--verbose=4', app])
    if (!details.includes(`TeamIdentifier=${status.mac_team_id}`) || !details.includes('Authority=Developer ID Application:')) fail()
    execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])
    execute('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app])
  } catch { fail() }
  return { ok: true, app, scheme: 'storenova' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) fail()
    process.stdout.write(`${JSON.stringify(registerConnectHelper({ pluginRoot: resolve(process.argv[2]) }))}\n`)
  } catch { process.stderr.write('LOCAL_PLUGIN_CONNECT_HELPER_UNTRUSTED\n'); process.exitCode = 1 }
}
