#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.argv[2] ?? resolve(pluginRoot, 'windows'))
if (process.platform !== 'win32') throw new Error('Windows Credential Manager helper can only be built on Windows')
mkdirSync(output, { recursive: true })
const project = resolve(pluginRoot, 'windows', 'StoreNovaCredentialHelper.csproj')
if (!existsSync(project)) throw new Error('Windows credential helper project is missing')
const result = spawnSync('dotnet', ['publish', project, '--configuration', 'Release', '--runtime', 'win-x64',
  '--self-contained', 'true', '--output', output, '-p:DebugType=None', '-p:DebugSymbols=false'], { encoding: 'utf8', windowsHide: true })
if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'dotnet publish failed')
process.stdout.write(`${JSON.stringify({ ok: true, output, credential_store: 'Credential Manager + DPAPI CurrentUser', dotnet_runtime_bundled: true, signed: false, production_ready: false })}\n`)
