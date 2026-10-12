import { describe, expect, it, vi } from 'vitest'
import { LAUNCHD_ENVIRONMENT_NAMES, restoreLaunchdEnvironment } from './launchd-environment.mjs'

describe('macOS launchd environment recovery', () => {
  it.each([undefined, '', '${MERCHANT_MCP_TOKEN_SOURCE}', 'environment'])('preserves explicit environment token priority with source %s', source => {
    const environment: Record<string, string | undefined> = {
      NODE_ENV: 'production', MERCHANT_MCP_TOKEN: 'fixture-explicit-token', MERCHANT_MCP_TOKEN_SOURCE: source,
    }
    const run = vi.fn((_command: string, args: string[]) => args[1] === 'MERCHANT_MCP_TOKEN_SOURCE' ? 'keychain' : '')
    restoreLaunchdEnvironment({ environment, platform: 'darwin', execFileSync: run })
    expect(environment.MERCHANT_MCP_TOKEN).toBe('fixture-explicit-token')
    expect(environment.MERCHANT_MCP_TOKEN_SOURCE).toBe(source)
    expect(run.mock.calls.map(([, args]) => args[1])).not.toContain('MERCHANT_MCP_TOKEN_SOURCE')
  })

  it.each(['lookup failure', 'empty value', 'unresolved placeholder'])('retries missing startup configuration after %s when launchd configuration becomes available', initialState => {
    const environment: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      MERCHANT_MCP_BASE_URL: undefined,
      MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}',
      MERCHANT_STRICT_AUTH: 'true',
    }
    let configurationAvailable = false
    const values: Record<string, string> = {
      MERCHANT_MCP_BASE_URL: 'https://merchant.example.test',
      MERCHANT_WORKSPACE_ID: 'ws_launchd_recovery_test',
      MERCHANT_STRICT_AUTH: 'false',
    }
    const run = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('/bin/launchctl')
      expect(args[0]).toBe('getenv')
      if (configurationAvailable) return values[args[1]!] ?? ''
      if (initialState === 'lookup failure') throw new Error('lookup unavailable')
      return initialState === 'unresolved placeholder' ? `\${${args[1]}}` : ''
    })

    expect(restoreLaunchdEnvironment({ environment, platform: 'darwin', execFileSync: run })).toEqual([])
    expect(environment.MERCHANT_MCP_BASE_URL).toBeUndefined()
    expect(environment.MERCHANT_WORKSPACE_ID).toBe('${MERCHANT_WORKSPACE_ID}')

    configurationAvailable = true
    run.mockClear()
    expect(restoreLaunchdEnvironment({ environment, platform: 'darwin', execFileSync: run })).toEqual([
      'MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID',
    ])
    expect(environment).toMatchObject({ ...values, MERCHANT_STRICT_AUTH: 'true' })
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(expect.arrayContaining([
      'MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID',
    ]))
    expect(run.mock.calls.map(([, args]) => args[1])).not.toContain('MERCHANT_STRICT_AUTH')

    run.mockClear()
    expect(restoreLaunchdEnvironment({ environment, platform: 'darwin', execFileSync: run })).toEqual([])
    expect(run.mock.calls.map(([, args]) => args[1])).not.toContain('MERCHANT_MCP_BASE_URL')
    expect(run.mock.calls.map(([, args]) => args[1])).not.toContain('MERCHANT_WORKSPACE_ID')
  })

  it('restores only missing configuration through an absolute launchctl path without secrets', () => {
    const environment: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      MERCHANT_MCP_BASE_URL: '${MERCHANT_MCP_BASE_URL}',
      MERCHANT_WORKSPACE_ID: '',
      MERCHANT_STRICT_AUTH: 'true',
      MERCHANT_MCP_TOKEN: undefined,
      MERCHANT_MCP_REFRESH_TOKEN: undefined,
    }
    const values: Record<string, string> = {
      MERCHANT_MCP_BASE_URL: 'https://merchant.example.test',
      MERCHANT_WORKSPACE_ID: 'ws_launchd_test',
      MERCHANT_STRICT_AUTH: 'false',
    }
    const run = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('/bin/launchctl')
      expect(args[0]).toBe('getenv')
      return values[args[1]!] ?? ''
    })

    const restored = restoreLaunchdEnvironment({ environment, platform: 'darwin', execFileSync: run })

    expect(restored).toEqual(['MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID'])
    expect(environment).toMatchObject({
      MERCHANT_MCP_BASE_URL: 'https://merchant.example.test',
      MERCHANT_WORKSPACE_ID: 'ws_launchd_test',
      MERCHANT_STRICT_AUTH: 'true',
    })
    expect(environment.MERCHANT_MCP_TOKEN).toBeUndefined()
    expect(environment.MERCHANT_MCP_REFRESH_TOKEN).toBeUndefined()
    expect(restored.every(name => LAUNCHD_ENVIRONMENT_NAMES.includes(name))).toBe(true)
  })

  it('keeps explicit process settings authoritative and skips test processes', () => {
    const run = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('/bin/launchctl')
      return args[1] === 'MERCHANT_WORKSPACE_ID' ? '${MERCHANT_WORKSPACE_ID}' : ''
    })
    const explicit = { PATH: '', NODE_ENV: 'production', MERCHANT_MCP_BASE_URL: 'https://explicit.example.test', MERCHANT_WORKSPACE_ID: '' }
    restoreLaunchdEnvironment({ environment: explicit, platform: 'darwin', execFileSync: run })
    expect(explicit.MERCHANT_MCP_BASE_URL).toBe('https://explicit.example.test')
    expect(explicit.MERCHANT_WORKSPACE_ID).toBe('')
    expect(run.mock.calls.map(([, args]) => args[1])).not.toContain('MERCHANT_MCP_BASE_URL')

    run.mockClear()
    const testEnvironment = { NODE_ENV: 'test', MERCHANT_MCP_BASE_URL: '' }
    expect(restoreLaunchdEnvironment({ environment: testEnvironment, platform: 'darwin', execFileSync: run })).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves missing settings unset when launchd lookup fails', () => {
    const environment: Record<string, string | undefined> = { NODE_ENV: 'production', MERCHANT_MCP_BASE_URL: undefined }
    const run = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('/bin/launchctl')
      if (args[1] === 'MERCHANT_MCP_BASE_URL') throw new Error('lookup failed')
      return ''
    })

    expect(restoreLaunchdEnvironment({ environment, platform: 'darwin', execFileSync: run })).toEqual([])
    expect(environment.MERCHANT_MCP_BASE_URL).toBeUndefined()
  })
})
