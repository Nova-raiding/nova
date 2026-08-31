#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const profiles = Object.freeze({
  api: Object.freeze(['apps/api', 'apps/plugin', 'packages']),
  worker: Object.freeze(['apps/worker', 'packages']),
})

const excludedDirectories = new Set([
  '.git',
  '.turbo',
  '__fixtures__',
  '__snapshots__',
  'artifacts',
  'coverage',
  'dist',
  'fixtures',
  'node_modules',
  'secret',
  'secrets',
  'test-results',
])

const digestPattern = /^sha256:[0-9a-f]{64}$/
const manifestLinePattern = /^([0-9a-f]{64})  ([^\r\n]+)$/

function fail(message) {
  process.stderr.write(`container source manifest failed: ${message}\n`)
  process.exit(1)
}

function usage() {
  process.stderr.write(
    'usage: generate-container-source-manifest.mjs generate <api|worker> <source-root> <manifest-output> <digest-output>\n' +
      '       generate-container-source-manifest.mjs generate-pair <source-root> <api-output-prefix> <worker-output-prefix>\n' +
      '       generate-container-source-manifest.mjs verify <api|worker> <manifest> <digest>\n',
  )
  process.exit(2)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function assertSafeRelativePath(path, profile) {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail(`manifest contains an unsafe path: ${JSON.stringify(path)}`)
  }
  if (!pathBelongsToProfile(path, profile) || isExcluded(path, false)) {
    fail(`manifest path is outside the fixed ${profile} input set: ${path}`)
  }
}

function isExcluded(path, directory) {
  const parts = path.split('/')
  const basename = parts.at(-1) ?? ''
  if (parts.some((part) => excludedDirectories.has(part))) return true
  if (basename === '.env' || basename.startsWith('.env.')) return true
  if (/^(?:\.?secrets?)(?:[._-]|$)/iu.test(basename) || /[._-](?:secret|secrets)(?:[._-]|$)/iu.test(basename)) return true
  if (/\.(?:map|pem|key|p12|pfx|tsbuildinfo)$/iu.test(basename)) return true
  if (/\.(?:test|spec|fixture)(?:\.[^.]+)+$/iu.test(basename) || /\.snap$/iu.test(basename)) return true
  if (directory && /^(?:test|tests|__tests__)$/u.test(basename)) return true
  return false
}

function rootFileBelongs(path) {
  return !path.includes('/') && (/^package.*\.json$/u.test(path) || /^tsconfig.*\.json$/u.test(path))
}

function pathBelongsToProfile(path, profile) {
  if (rootFileBelongs(path)) return true
  return profiles[profile].some((scope) => path === scope || path.startsWith(`${scope}/`))
}

function sourcePath(root, relativePath) {
  const target = resolve(root, ...relativePath.split('/'))
  const expectedPrefix = `${resolve(root)}${sep}`
  if (target !== resolve(root) && !target.startsWith(expectedPrefix)) {
    fail(`resolved path escapes source root: ${relativePath}`)
  }
  return target
}

function collectDirectory(root, relativeDirectory, profile, files) {
  const absoluteDirectory = sourcePath(root, relativeDirectory)
  let entries
  try {
    const stat = lstatSync(absoluteDirectory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`required ${profile} input is not a real directory: ${relativeDirectory}`)
    }
    entries = readdirSync(absoluteDirectory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`required ${profile} input is missing: ${relativeDirectory}`)
    throw error
  }
  entries.sort((left, right) => compareUtf8(left.name, right.name))
  for (const entry of entries) {
    const path = `${relativeDirectory}/${entry.name}`
    if (isExcluded(path, entry.isDirectory())) continue
    assertSafeRelativePath(path, profile)
    const absolutePath = sourcePath(root, path)
    const stat = lstatSync(absolutePath)
    if (stat.isSymbolicLink()) fail(`symbolic links are forbidden in source inputs: ${path}`)
    if (stat.isDirectory()) {
      collectDirectory(root, path, profile, files)
    } else if (stat.isFile()) {
      files.push(path)
    } else {
      fail(`non-regular source input is forbidden: ${path}`)
    }
  }
}

function collectFiles(root, profile) {
  let canonicalRoot
  try {
    canonicalRoot = realpathSync(root)
  } catch {
    fail(`source root is missing: ${root}`)
  }
  const files = []
  for (const scope of profiles[profile]) collectDirectory(canonicalRoot, scope, profile, files)
  const rootMetadata = new Set()
  for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
    if (!rootFileBelongs(entry.name) || isExcluded(entry.name, false)) continue
    assertSafeRelativePath(entry.name, profile)
    const stat = lstatSync(sourcePath(canonicalRoot, entry.name))
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(`root build metadata must be a regular non-symbolic-link file: ${entry.name}`)
    }
    files.push(entry.name)
    rootMetadata.add(entry.name)
  }
  for (const required of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    if (!rootMetadata.has(required)) fail(`required root build metadata is missing: ${required}`)
  }
  files.sort(compareUtf8)
  if (files.length === 0) fail(`fixed ${profile} input set contains no files`)
  return { canonicalRoot, files }
}

function renderManifest(root, files, digestCache = new Map()) {
  return Buffer.from(
    files.map((path) => {
      let digest = digestCache.get(path)
      if (!digest) {
        digest = sha256(readFileSync(sourcePath(root, path)))
        digestCache.set(path, digest)
      }
      return `${digest}  ${path}\n`
    }).join(''),
    'utf8',
  )
}

function writeManifest(profile, sourceRoot, manifestOutput, digestOutput, digestCache = new Map()) {
  const { canonicalRoot, files } = collectFiles(sourceRoot, profile)
  const manifest = renderManifest(canonicalRoot, files, digestCache)
  const manifestDigest = sha256(manifest)
  mkdirSync(dirname(resolve(manifestOutput)), { recursive: true })
  writeFileSync(manifestOutput, manifest)
  mkdirSync(dirname(resolve(digestOutput)), { recursive: true })
  writeFileSync(digestOutput, `sha256:${manifestDigest}\n`)
  return { files: files.length, digest: manifestDigest }
}

function readAndValidateManifest(profile, manifestPath, digestPath) {
  let manifest
  let digestText
  try {
    manifest = readFileSync(manifestPath)
    digestText = readFileSync(digestPath, 'utf8')
  } catch (error) {
    fail(`manifest or digest is missing: ${error.message}`)
  }
  const expectedDigestText = `sha256:${sha256(manifest)}\n`
  if (!digestPattern.test(digestText.trim()) || digestText !== expectedDigestText) {
    fail('manifest total SHA-256 is malformed or does not match the manifest bytes')
  }
  const text = manifest.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(manifest) || text.length === 0 || !text.endsWith('\n')) {
    fail('manifest must be non-empty canonical UTF-8 ending in one newline')
  }
  const lines = text.slice(0, -1).split('\n')
  let previous = ''
  const seen = new Set()
  for (const line of lines) {
    const match = manifestLinePattern.exec(line)
    if (!match) fail(`manifest line is malformed: ${JSON.stringify(line)}`)
    const [, hash, path] = match
    assertSafeRelativePath(path, profile)
    if (seen.has(path)) fail(`manifest contains a duplicate path: ${path}`)
    if (previous !== '' && compareUtf8(previous, path) >= 0) fail('manifest paths are not strictly sorted')
    if (!/^[0-9a-f]{64}$/u.test(hash)) fail(`manifest SHA-256 is malformed for ${path}`)
    seen.add(path)
    previous = path
  }
  return manifest
}

const arguments_ = process.argv.slice(2)
const [command, profile, firstPath, secondPath, digestOutput] = arguments_

if (command === 'generate-pair') {
  if (arguments_.length !== 4 || !profile || !firstPath || !secondPath) usage()
  const digestCache = new Map()
  const api = writeManifest('api', profile, `${firstPath}.manifest`, `${firstPath}.manifest.sha256`, digestCache)
  const worker = writeManifest('worker', profile, `${secondPath}.manifest`, `${secondPath}.manifest.sha256`, digestCache)
  process.stdout.write(`source manifest pair generated: api_files=${api.files} api_digest=sha256:${api.digest} worker_files=${worker.files} worker_digest=sha256:${worker.digest}\n`)
  process.exit(0)
}

if (!command || !profile || !firstPath || !secondPath || !(profile in profiles)) usage()

if (command === 'generate') {
  if (arguments_.length !== 5 || !digestOutput) usage()
  const result = writeManifest(profile, firstPath, secondPath, digestOutput)
  process.stdout.write(`source manifest generated: profile=${profile} files=${result.files} digest=sha256:${result.digest}\n`)
} else if (command === 'verify') {
  if (arguments_.length !== 4) usage()
  readAndValidateManifest(profile, firstPath, secondPath)
  process.stdout.write(`source manifest verified: profile=${profile}\n`)
} else {
  usage()
}
