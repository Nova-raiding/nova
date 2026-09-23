#!/usr/bin/env node
// Called only after the runner checks root ownership and protected path chains.
// The control installer rewrites the source shebang to a fixed Node path.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [sourcePath, helperPath, digestPath] = process.argv.slice(2)
if (!sourcePath?.startsWith('/') || !helperPath?.startsWith('/') || !digestPath?.startsWith('/')) throw new Error('protected helper verification paths are required')
const source = readFileSync(sourcePath)
const installed = readFileSync(helperPath)
const trustDigest = readFileSync(digestPath, 'utf8').trim()
const sourceEnd = source.indexOf(10), installedEnd = installed.indexOf(10)
if (sourceEnd < 0 || installedEnd < 0 || !/^#!\/[A-Za-z0-9._/-]+$/u.test(installed.subarray(0, installedEnd).toString('utf8')) ||
    !installed.subarray(installedEnd + 1).equals(source.subarray(sourceEnd + 1)) ||
    !/^[0-9a-f]{64}$/u.test(trustDigest) || createHash('sha256').update(installed).digest('hex') !== trustDigest) {
  throw new Error('installed protected helper is not the reviewed seven-container version')
}
process.stdout.write('installed protected bridge helper matches reviewed source and trust digest\n')
