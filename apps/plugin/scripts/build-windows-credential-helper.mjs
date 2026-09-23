#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.argv[2] ?? resolve(pluginRoot, 'windows'))
if (process.platform !== 'win32') throw new Error('Windows Credential Manager helper can only be built on Windows')
mkdirSync(output, { recursive: true })
const project = resolve(pluginRoot, 'windows', 'StoreNovaCredentialHelper.csproj')
if (!existsSync(project)) throw new Error('Windows credential helper project is missing')
const source = resolve(pluginRoot, 'windows', 'StoreNovaCredentialHelper.cs')
if (!existsSync(source)) throw new Error('Windows credential helper source is missing')
// dotnet restore/publish writes obj and bin next to the project. Keep those
// generated files outside the release source tree so its clean-tree gate is real.
const buildRoot = mkdtempSync(resolve(tmpdir(), 'storenova-credential-build-'))
try {
  const buildProject = resolve(buildRoot, 'StoreNovaCredentialHelper.csproj')
  cpSync(project, buildProject)
  cpSync(source, resolve(buildRoot, 'StoreNovaCredentialHelper.cs'))
  const result = spawnSync('dotnet', ['publish', buildProject, '--configuration', 'Release', '--runtime', 'win-x64',
    '--self-contained', 'true', '--output', output, '-p:DebugType=None', '-p:DebugSymbols=false'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || result.error?.message || 'dotnet publish failed')
} finally {
  rmSync(buildRoot, { recursive: true, force: true })
}
process.stdout.write(`${JSON.stringify({ ok: true, output, credential_store: 'Credential Manager + DPAPI CurrentUser', dotnet_runtime_bundled: true, signed: false, production_ready: false })}\n`)
