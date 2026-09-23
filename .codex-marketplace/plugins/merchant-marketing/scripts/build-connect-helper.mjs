#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.argv[2] ?? resolve(pluginRoot, 'macos', 'Store Nova Connect.app'))
const executableDirectory = resolve(output, 'Contents', 'MacOS')
const executable = resolve(executableDirectory, 'store-nova-connect')
const version = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8')).version
if (process.platform !== 'darwin') throw new Error('Store Nova Connect helper can only be built on macOS')
if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('invalid plugin version')

rmSync(output, { recursive: true, force: true })
mkdirSync(executableDirectory, { recursive: true })
const build = spawnSync('/usr/bin/swiftc', ['-parse-as-library', '-framework', 'AppKit',
  resolve(pluginRoot, 'macos', 'store-nova-connect-helper.swift'), '-o', executable], { encoding: 'utf8' })
if (build.status !== 0) throw new Error(build.stderr?.trim() || 'swiftc failed')
writeFileSync(resolve(output, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>CFBundleDisplayName</key><string>Store Nova Connect</string>
<key>CFBundleExecutable</key><string>store-nova-connect</string>
<key>CFBundleIdentifier</key><string>com.storenova.connect-helper</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>Store Nova Connect</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version.split('+')[0]}</string>
<key>CFBundleVersion</key><string>${version.replace(/[^0-9]/gu, '').slice(0, 18) || '1'}</string>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>com.storenova.connect</string>
<key>CFBundleURLSchemes</key><array><string>storenova</string></array>
</dict></array>
<key>LSUIElement</key><true/>
</dict></plist>\n`, { mode: 0o644 })
process.stdout.write(`${JSON.stringify({ ok: true, app: output, scheme: 'storenova', secrets_in_url: false })}\n`)
