import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const verifier = resolve(pluginRoot, 'scripts/verify-installed-bridge.mjs')
const bundledCommand = process.platform === 'win32' ? './runtime/node.exe' : './runtime/node'

describe('installed MCP bridge verification', () => {
  it('accepts the exact bundled Node startup transformation and runs its tool discovery', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-bundled-verify-'))
    const installed = resolve(directory, 'installed')
    try {
      cpSync(pluginRoot, installed, { recursive: true })
      const runtime = resolve(installed, 'runtime')
      mkdirSync(runtime)
      const bundledNode = resolve(installed, bundledCommand)
      // Homebrew's macOS node is a small launcher linked to a nearby dylib;
      // copying that launcher alone makes it unusable in a temporary directory.
      if (process.platform === 'darwin') symlinkSync(process.execPath, bundledNode)
      else { copyFileSync(process.execPath, bundledNode); chmodSync(bundledNode, 0o755) }
      const configPath = resolve(installed, '.mcp.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      config.mcpServers['merchant-marketing'].command = bundledCommand
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

      const result = spawnSync(process.execPath, [verifier, '--source', pluginRoot, '--installed', installed], { encoding: 'utf8' })
      const evidence = JSON.parse(result.stdout)
      expect(result.status, JSON.stringify({ stderr: result.stderr, manifest: evidence.manifest, discovery: evidence.tools.installed_discovery_error })).toBe(0)
      expect(evidence.manifest.errors).toEqual([])
      expect(evidence.tools.installed_discovery_error).toBeNull()
      expect(evidence.runtime_files.find((file: { path: string }) => file.path === '.mcp.json')).toMatchObject({ matches: true })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a bundled runtime path when its executable is absent', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'merchant-bundled-verify-missing-'))
    const installed = resolve(directory, 'installed')
    try {
      cpSync(pluginRoot, installed, { recursive: true })
      const configPath = resolve(installed, '.mcp.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      config.mcpServers['merchant-marketing'].command = bundledCommand
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

      const result = spawnSync(process.execPath, [verifier, '--source', pluginRoot, '--installed', installed], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).manifest.errors).toContain(
        `MCP startup must use node or the present ${bundledCommand} runtime with ./mcp/bridge.mjs`,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
