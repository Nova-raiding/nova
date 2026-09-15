import { describe, expect, it } from 'vitest'
// @ts-ignore JavaScript runtime module
import { loadManagedToken } from './managed-token.mjs'

const configured = () => ({
  MERCHANT_MCP_TOKEN_SOURCE: 'launchd',
  MERCHANT_MCP_BASE_URL: 'https://merchant.example.test/mcp',
  MERCHANT_WORKSPACE_ID: 'ws_test',
  MERCHANT_MCP_TOKEN: 'stale-token',
})
const read = (name: string) => ({ ...configured(), MERCHANT_MCP_TOKEN: 'fresh-token' } as Record<string, string>)[name] || ''

describe('managed credential startup', () => {
  it('preserves explicit credentials by default without consulting launchd', () => {
    const env = { ...configured(), MERCHANT_MCP_TOKEN_SOURCE: '' }
    loadManagedToken(env, 'darwin', () => { throw new Error('must not read') })
    expect(env.MERCHANT_MCP_TOKEN).toBe('stale-token')
  })
  it('uses the fresh token only for the pinned endpoint and workspace', () => {
    const env = configured()
    loadManagedToken(env, 'darwin', read)
    expect(env.MERCHANT_MCP_TOKEN).toBe('fresh-token')
  })
  it.each(['MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID', 'MERCHANT_MCP_TOKEN'])('fails closed when %s differs or is missing', name => {
    const env = configured()
    expect(() => loadManagedToken(env, 'darwin', (key: string) => key === name ? '' : read(key))).toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
    expect(env.MERCHANT_MCP_TOKEN).toBeUndefined()
  })
  it.each(['MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID'])('rejects a different nonempty %s', name => {
    const env = configured()
    expect(() => loadManagedToken(env, 'darwin', (key: string) => key === name ? 'different' : read(key))).toThrow()
    expect(env.MERCHANT_MCP_TOKEN).toBeUndefined()
  })
  it.each(['linux', 'win32'])('rejects managed credentials on %s', platform => {
    expect(() => loadManagedToken(configured(), platform, read)).toThrow()
  })
  it('rejects unreadable credentials and placeholders', () => {
    expect(() => loadManagedToken(configured(), 'darwin', () => { throw new Error('sensitive-reader-error') })).toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
    expect(() => loadManagedToken(configured(), 'darwin', (key: string) => key === 'MERCHANT_MCP_TOKEN' ? '${TOKEN}' : read(key))).toThrow()
  })
  it.each(['MERCHANT_ACTOR_ID', 'MERCHANT_MCP_ROLE'])('rejects unverifiable principal pin %s', name => {
    expect(() => loadManagedToken({ ...configured(), [name]: 'explicit' }, 'darwin', read)).toThrow()
  })
  it('rejects an unknown source', () => {
    expect(() => loadManagedToken({ ...configured(), MERCHANT_MCP_TOKEN_SOURCE: 'unknown' }, 'darwin', read)).toThrow()
  })
})
