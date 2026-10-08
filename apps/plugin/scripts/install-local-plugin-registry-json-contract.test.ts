import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const pluginRoot = resolve(process.cwd(), 'apps/plugin')
const installer = resolve(pluginRoot, 'scripts/install-local-plugin.mjs')
const pluginVersion = JSON.parse(readFileSync(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8')).version as string

describe('local stdio installer registry JSON contract', () => {
  it('fails closed on malformed registry JSON before adding a marketplace or installing a cache', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'merchant-plugin-invalid-registry-json-'))
    const localSource = resolve(temp, 'marketplace')
    const marketplacePlugin = resolve(localSource, 'plugins/merchant-marketing')
    const codexHome = resolve(temp, 'codex-home')
    const cacheRoot = resolve(codexHome, 'plugins/cache')
    const installed = resolve(cacheRoot, 'merchant-local-test/merchant-marketing', pluginVersion)
    const calls = resolve(temp, 'codex-calls.jsonl')
    const codex = resolve(temp, 'codex')
    mkdirSync(marketplacePlugin, { recursive: true })
    cpSync(pluginRoot, marketplacePlugin, { recursive: true })
    writeFileSync(resolve(marketplacePlugin, 'bundle-profile.json'), `${JSON.stringify({
      schema_version: '1', profile: 'qa-broker', qa_only: true, release_eligible: false,
      credential_broker: { path: 'mcp/keychain-broker.mjs', included: true, authenticated_peer_identity: false, release_eligible: false },
    })}\n`)
    writeFileSync(resolve(localSource, 'marketplace.json'), JSON.stringify({
      name: 'merchant-local-test',
      plugins: [{ name: 'merchant-marketing', source: { source: 'local', path: './plugins/merchant-marketing' } }],
    }))
    writeFileSync(codex, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv.slice(2).join(' ') === 'plugin marketplace list --json') {
  process.stdout.write('{not-json')
  process.exit(0)
}
process.stderr.write('unexpected Codex mutation command')
process.exit(2)
`)
    chmodSync(codex, 0o755)

    try {
      const result = spawnSync(process.execPath, [installer,
        '--source', pluginRoot,
        '--local-source', localSource,
        '--codex', codex,
        '--codex-home', codexHome,
        '--installed', installed,
        '--package-profile', 'qa-broker',
      ], {
        encoding: 'utf8',
        env: { ...process.env, FAKE_CODEX_CALLS: calls },
        timeout: 30_000,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Codex returned invalid marketplace JSON')
      const codexCommands = readFileSync(calls, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line) as string[])
      expect(codexCommands).toEqual([['plugin', 'marketplace', 'list', '--json']])
      expect(codexCommands.filter(args => args[2] === 'add' || args[2] === 'remove' || args[1] === 'add'))
        .toEqual([])
      expect(existsSync(installed)).toBe(false)
      expect(existsSync(cacheRoot)).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 30_000)
})
