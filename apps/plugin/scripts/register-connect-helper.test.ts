import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Native installer module intentionally has no build step.
import { registerConnectHelper } from './register-connect-helper.mjs'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('signed macOS connect helper registration', () => {
  const fixture = (status: Record<string, unknown>) => {
    const root = mkdtempSync(resolve(tmpdir(), 'store-nova-connect-registration-'))
    directories.push(root)
    mkdirSync(resolve(root, 'Store Nova Connect.app/Contents/MacOS'), { recursive: true })
    writeFileSync(resolve(root, 'Store Nova Connect.app/Contents/MacOS/store-nova-connect'), '')
    writeFileSync(resolve(root, 'bundle-status.json'), JSON.stringify(status))
    return root
  }

  it('refuses an unsigned candidate before registering the protocol', () => {
    const root = fixture({ release_status: 'unsigned_candidate', ready_to_install: false })
    let calls = 0
    expect(() => registerConnectHelper({ pluginRoot: root, run: () => { calls++; return { status: 0 } } })).toThrow('UNTRUSTED')
    expect(calls).toBe(0)
  })

  it('checks Developer ID and Gatekeeper before Launch Services registration', () => {
    const root = fixture({ release_status: 'signed_notarized', ready_to_install: true, source_dirty: false,
      mac_team_id: 'ABCD123456', mac_signer_thumbprint: 'A'.repeat(40) })
    const calls: string[] = []
    const result = registerConnectHelper({ pluginRoot: root, run: (command: string, args: string[]) => {
      calls.push(`${command} ${args[0]}`)
      return { status: 0, stdout: '', stderr: args[0] === '--display'
        ? 'Authority=Developer ID Application: Store Nova\nTeamIdentifier=ABCD123456' : '' }
    } })
    expect(result).toMatchObject({ ok: true, scheme: 'storenova' })
    expect(calls).toEqual(['/usr/bin/codesign --verify', '/usr/bin/codesign --display',
      '/usr/sbin/spctl --assess', '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f'])
  })
})
