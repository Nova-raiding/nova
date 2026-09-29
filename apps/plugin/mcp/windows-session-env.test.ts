import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error Native Node runtime module has no declaration file.
import { readWindowsUserSession, restoreWindowsSession, WINDOWS_SESSION_NAMES } from './windows-session-env.mjs'

const valid = () => ({ MERCHANT_MCP_BASE_URL: 'https://yxsona.com', MERCHANT_WORKSPACE_ID: 'ws_windows',
  MERCHANT_MCP_TOKEN_SOURCE: 'windows_credential_manager', MERCHANT_STRICT_AUTH: 'true',
  MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false', MERCHANT_MCP_WRITE_ENABLED: 'false', DEPLOY_ENV: 'local_desktop' })

describe('Windows user session recovery', () => {
  it('restores only the seven public configuration values', () => {
    const env = { MERCHANT_MCP_TOKEN: 'existing-secret' }
    restoreWindowsSession(env, 'win32', () => valid())
    expect(env).toEqual({ ...valid(), MERCHANT_MCP_TOKEN: 'existing-secret' })
    expect(WINDOWS_SESSION_NAMES).toHaveLength(7)
  })
  it('preserves explicit configuration and does not read User when complete', () => {
    const read = vi.fn(() => valid())
    const env = { ...valid(), MERCHANT_WORKSPACE_ID: 'ws_explicit' }
    restoreWindowsSession(env, 'win32', read)
    expect(read).not.toHaveBeenCalled()
    expect(env.MERCHANT_WORKSPACE_ID).toBe('ws_explicit')
  })
  it('keeps explicit workspace while filling missing fields', () => {
    const env = { MERCHANT_WORKSPACE_ID: 'ws_explicit' }
    restoreWindowsSession(env, 'win32', () => valid())
    expect(env).toEqual({ ...valid(), MERCHANT_WORKSPACE_ID: 'ws_explicit' })
  })
  it.each([
    ['MERCHANT_MCP_BASE_URL', 'https://evil.example'], ['MERCHANT_WORKSPACE_ID', 'invalid'],
    ['MERCHANT_MCP_TOKEN_SOURCE', 'environment'], ['MERCHANT_STRICT_AUTH', 'false'],
    ['MERCHANT_ALLOW_FIXTURE_FALLBACK', 'true'], ['MERCHANT_MCP_WRITE_ENABLED', 'true'], ['DEPLOY_ENV', 'test'],
  ])('rejects invalid %s without partial mutation', (key, value) => {
    const env = {}
    expect(() => restoreWindowsSession(env, 'win32', () => ({ ...valid(), [key]: value }))).toThrow('MCP_WINDOWS_SESSION_CONFIGURATION_INVALID')
    expect(env).toEqual({})
  })
  it.each([{ MERCHANT_WORKSPACE_ID: 'ws_partial' }, null, [], { ...valid(), MERCHANT_MCP_TOKEN: 'secret' }])('rejects incomplete or unexpected user records', record => {
    const env = {}
    expect(() => restoreWindowsSession(env, 'win32', () => record)).toThrow('MCP_WINDOWS_SESSION_CONFIGURATION_INVALID')
    expect(env).toEqual({})
  })
  it.each([{}, Object.fromEntries(WINDOWS_SESSION_NAMES.map((name: string) => [name, null]))])('keeps first-use unconfigured discovery available', stored => {
    const env = {}
    restoreWindowsSession(env, 'win32', () => stored)
    expect(env).toEqual({})
  })
  it('preserves complete explicit developer configuration without reading User', () => {
    const env = { ...valid(), MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_MCP_WRITE_ENABLED: 'true' }
    const before = { ...env }
    const read = vi.fn()
    restoreWindowsSession(env, 'win32', read)
    expect(env).toEqual(before)
    expect(read).not.toHaveBeenCalled()
  })
  it('preserves installer discovery probe with explicit environment credentials', () => {
    const env = { NODE_ENV: 'production', MERCHANT_MCP_TOKEN_SOURCE: 'environment', MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_WORKSPACE_ID: 'ws_install_verify' }
    const before = { ...env }
    const read = vi.fn(() => valid())
    restoreWindowsSession(env, 'win32', read)
    expect(env).toEqual(before)
    expect(read).not.toHaveBeenCalled()
  })
  it('does not reject explicit dev fields while recovering safe missing fields', () => {
    const env = { MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_MCP_WRITE_ENABLED: 'true' }
    restoreWindowsSession(env, 'win32', () => valid())
    expect(env).toEqual({ ...valid(), MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:8790', MERCHANT_MCP_WRITE_ENABLED: 'true' })
  })
  it('sanitizes reader failures', () => {
    expect(() => restoreWindowsSession({}, 'win32', () => { throw new Error('secret') }))
      .toThrow(/^MCP_WINDOWS_SESSION_CONFIGURATION_INVALID$/u)
  })
  it.each([['darwin', {}], ['win32', { NODE_ENV: 'test' }], ['win32', { VITEST: 'true' }]])('skips non-Windows and test environments', (platform, env) => {
    const read = vi.fn()
    restoreWindowsSession(env, platform, read)
    expect(read).not.toHaveBeenCalled()
  })
  it('reads User scope once with a fixed script and bounded execution', () => {
    const run = vi.fn(() => JSON.stringify(valid()))
    expect(readWindowsUserSession({ SystemRoot: 'C:\\Windows' }, run)).toEqual(valid())
    expect(run).toHaveBeenCalledWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive']), expect.objectContaining({ timeout: 5000, maxBuffer: 16384 }))
    const script = run.mock.calls[0] as unknown as [string, string[]]
    expect(script[1].at(-1)).toContain("GetEnvironmentVariable($name,'User')")
    expect(script[1].at(-1)).not.toContain("'MERCHANT_MCP_TOKEN'")
    expect(script[1].at(-1)).not.toContain('REFRESH_TOKEN')
  })
  it('sanitizes PowerShell errors and rejects invalid JSON or missing system path', () => {
    expect(() => readWindowsUserSession({}, vi.fn())).toThrow(/^MCP_WINDOWS_SESSION_CONFIGURATION_INVALID$/u)
    expect(() => readWindowsUserSession({ SystemRoot: 'C:\\Windows' }, () => 'secret')).toThrow(/^MCP_WINDOWS_SESSION_CONFIGURATION_INVALID$/u)
    expect(() => readWindowsUserSession({ SystemRoot: 'C:\\Windows' }, () => { throw new Error('secret') }))
      .toThrow(/^MCP_WINDOWS_SESSION_CONFIGURATION_INVALID$/u)
  })
})
