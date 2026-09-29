import { createHash } from 'node:crypto'
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
    const certificate = Buffer.from('test-developer-id-certificate')
    const root = fixture({ release_status: 'signed_notarized', ready_to_install: true, source_dirty: false,
      mac_team_id: 'ABCD123456', mac_signer_thumbprint: createHash('sha1').update(certificate).digest('hex').toUpperCase() })
    const calls: string[] = []
    const result = registerConnectHelper({ pluginRoot: root, run: (command: string, args: string[]) => {
      calls.push(`${command} ${args[0]}`)
      if (args.includes('--extract-certificates')) writeFileSync(`${args[args.indexOf('--extract-certificates') + 1]}0`, certificate)
      return { status: 0, stdout: '', stderr: args.includes('--requirements')
        ? 'designated => anchor apple generic and certificate leaf[subject.OU] = ABCD123456'
        : args[0] === '--display'
          ? 'Authority=Developer ID Application: Store Nova\nTeamIdentifier=ABCD123456\nflags=0x10000(runtime)\nTimestamp=Sep 30, 2026' : '' }
    } })
    expect(result).toMatchObject({ ok: true, scheme: 'storenova' })
    expect(calls).toEqual(['/usr/bin/codesign --verify', '/usr/bin/codesign --display', '/usr/bin/codesign --display', '/usr/bin/codesign --display',
      '/usr/sbin/spctl --assess', '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f'])
  })

  it('refuses a signed app when the actual leaf certificate differs from the release manifest', () => {
    const root = fixture({ release_status: 'signed_notarized', ready_to_install: true, source_dirty: false,
      mac_team_id: 'ABCD123456', mac_signer_thumbprint: 'A'.repeat(40) })
    expect(() => registerConnectHelper({ pluginRoot: root, run: (_command: string, args: string[]) => {
      if (args.includes('--extract-certificates')) writeFileSync(`${args[args.indexOf('--extract-certificates') + 1]}0`, 'different-certificate')
      return { status: 0, stdout: '', stderr: args.includes('--requirements')
        ? 'designated => anchor apple generic and certificate leaf[subject.OU] = ABCD123456'
        : args[0] === '--display' ? 'Authority=Developer ID Application: Store Nova\nTeamIdentifier=ABCD123456\nflags=0x10000(runtime)\nTimestamp=Sep 30, 2026' : '' }
    } })).toThrow('UNTRUSTED')
  })
})
