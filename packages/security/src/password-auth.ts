import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'

/** Passwords are deliberately kept in this small module so callers cannot
 * accidentally persist or log a clear-text credential. */
export const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export function validatePassword(password: string) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256 || !/[A-Za-z]/u.test(password) || !/[0-9]/u.test(password)) {
    throw new Error('PASSWORD_POLICY_INVALID')
  }
}

export async function hashPassword(password: string) {
  validatePassword(password)
  return argon2.hash(password, ARGON2ID_OPTIONS)
}

export async function verifyPassword(hash: string, password: string) {
  if (!hash || typeof password !== 'string' || password.length > 256) return false
  try { return await argon2.verify(hash, password) } catch { return false }
}

export function newOpaqueToken(bytes = 32) { return randomBytes(bytes).toString('base64url') }
export function tokenDigest(token: string) { return createHash('sha256').update(token).digest('hex') }
export function normalizeLogin(value: string) { return value.trim().toLowerCase() }
