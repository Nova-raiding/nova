#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.argv[2] ?? resolve(pluginRoot, 'windows', 'StoreNovaConnectHelper.exe'))
const compiler = process.env.STORENOVA_WINDOWS_CSC_PATH
if (process.platform !== 'win32') throw new Error('Store Nova Windows helper can only be built on Windows')
if (!compiler || !existsSync(compiler)) throw new Error('STORENOVA_WINDOWS_CSC_PATH must name a trusted C# compiler')

mkdirSync(dirname(output), { recursive: true })
const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${output}`,
  resolve(pluginRoot, 'windows', 'StoreNovaConnectHelper.cs')], { encoding: 'utf8' })
if (build.status !== 0) throw new Error(build.stderr?.trim() || build.stdout?.trim() || 'C# compiler failed')
const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex')
writeFileSync(`${output}.sha256`, `${sha256}  ${output.split(/[\\/]/u).at(-1)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ ok: true, executable: output, sha256, signed: false, production_ready: false })}\n`)
