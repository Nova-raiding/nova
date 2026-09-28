#!/usr/bin/env node
// Fixed-path read-only Bridge 255 host preflight. No runtime adapter, Docker,
// PostgreSQL writer, nonce consumer, or journal mutation is exposed here.
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProtectedBridge255StateStore } from './ecs-bridge-255-state-store.mjs'

const FIXED = '/usr/local/libexec/merchant/ecs-bridge-255-transition'
const TRUST = '/run/release-security/evidence-trust'
const DIGEST = `${TRUST}/production-bridge-255-transition-sha256`
const requireValue = (ok, reason) => { if (!ok) throw new Error(`BRIDGE_255_TRANSITION_${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function readProtected(path, mode, maximum = 4 * 1024 * 1024) {
  requireValue(realpathSync(path) === path, 'PATH_NOT_CANONICAL')
  const before = lstatSync(path)
  requireValue(before.isFile() && !before.isSymbolicLink() && before.uid === 0
    && before.nlink === 1 && (before.mode & 0o777) === mode
    && before.size > 0 && before.size <= maximum, 'PROTECTED_FILE_INVALID')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    requireValue(opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1,
      'FILE_CHANGED_WHILE_OPENING')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

export function verifyInstalledBridge255Transition() {
  requireValue(process.getuid?.() === 0 && process.geteuid?.() === 0, 'ROOT_REQUIRED')
  requireValue(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'CLEAN_NODE_ENVIRONMENT_REQUIRED')
  requireValue(fileURLToPath(import.meta.url) === FIXED
    && process.argv[1] && resolve(process.argv[1]) === FIXED, 'FIXED_INSTALL_REQUIRED')
  const executable = readProtected(FIXED, 0o755)
  const expected = readProtected(DIGEST, 0o444, 128).toString('utf8').trim()
  requireValue(/^[a-f0-9]{64}$/u.test(expected) && sha(executable) === expected,
    'INSTALLED_SOURCE_DIGEST_INVALID')
  return true
}

export async function runBridge255TransitionCommand(args = process.argv.slice(2)) {
  requireValue(args.length === 1 && ['status', 'verify-plan'].includes(args[0]), 'COMMAND_NOT_SUPPORTED')
  verifyInstalledBridge255Transition()
  const store = openProtectedBridge255StateStore()
  const status = await store.inspectApprovedAttempt()
  const command = args[0]
  process.stdout.write(`${JSON.stringify({ ...status, command,
    plan_valid: true, controller_mode: 'read_only_preflight' })}\n`)
  return status
}

if (process.argv[1] && fileURLToPath(import.meta.url) === FIXED) {
  runBridge255TransitionCommand().catch(error => {
    const reason = typeof error?.message === 'string' && /^BRIDGE_255_[A-Z0-9_]+$/u.test(error.message)
      ? ` (${error.message})` : ''
    process.stderr.write(`bridge 255 protected status rejected${reason}; no production mutation was performed\n`)
    process.exitCode = 1
  })
}
