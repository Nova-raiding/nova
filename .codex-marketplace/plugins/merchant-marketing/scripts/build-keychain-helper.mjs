#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { chmodSync, renameSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Run only against the locally installed, verified plugin source. No network,
// signing credentials or Keychain access is performed by this build step.
try {
  if (process.platform !== 'darwin') throw new Error('macOS required')
  const directory = fileURLToPath(new URL('../mcp/', import.meta.url))
  const source = join(directory, 'keychain-credential-helper.swift')
  const target = join(directory, 'keychain-credential-helper')
  const temporary = mkdtempSync(join(dirname(target), '.keychain-build-'))
  const output = join(temporary, 'keychain-credential-helper')
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', output], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
  chmodSync(output, 0o700)
  renameSync(output, target)
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  writeFileSync(join(directory, 'keychain-credential-helper.build.json'), JSON.stringify({ schema_version: '1', source_sha256: digest(source), binary_sha256: digest(target), platform: process.platform, arch: process.arch }) + '\n', { mode: 0o600 })
  process.stdout.write('Store Nova Keychain helper built locally. No credentials were accessed.\n')
} catch {
  // Compiler diagnostics and subprocess metadata are not credential channels.
  process.stderr.write('LOCAL_PLUGIN_KEYCHAIN_BUILD_FAILED: 需要可用的 macOS Swift 编译工具链；没有编译成功，不会降级存储凭据。\n')
  process.exitCode = 1
}
