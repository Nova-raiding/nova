import { describe, expect, it } from 'vitest'
import { assertRelayBaseUrl, assertRelayUrl, relaySecurityFromEnv } from './relay-security.js'

describe('model relay security policy', () => {
  it('requires a valid HTTPS base URL without embedded credentials, query, or fragment', () => {
    expect(() => assertRelayBaseUrl('not a URL')).toThrow('valid HTTPS URL')
    expect(() => assertRelayBaseUrl('http://relay.example/v1')).toThrow('HTTPS')
    expect(() => assertRelayBaseUrl('https://user:pass@relay.example/v1')).toThrow('credentials')
    expect(() => assertRelayBaseUrl('https://relay.example/v1?token=secret')).toThrow('credentials')
    expect(() => assertRelayBaseUrl('https://relay.example/v1#fragment')).toThrow('credentials')
    expect(() => assertRelayBaseUrl('https://relay.example/v1')).not.toThrow()
  })

  it('fails closed for production relay config without an explicit matching host allowlist', () => {
    expect(relaySecurityFromEnv({
      NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example/v1',
    })).toBeUndefined()
    expect(relaySecurityFromEnv({
      NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://relay.example/v1', MODEL_RELAY_ALLOWED_HOSTS: 'other.example',
    })).toBeUndefined()
    expect(relaySecurityFromEnv({
      NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'http://relay.example/v1', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example',
    })).toBeUndefined()
    expect(relaySecurityFromEnv({
      NODE_ENV: 'production', MODEL_RELAY_BASE_URL: 'https://127.0.0.1/v1', MODEL_RELAY_ALLOWED_HOSTS: '127.0.0.1',
    })).toBeUndefined()
  })

  it('normalizes an explicit production allowlist and validates targets without network access for test domains', async () => {
    const policy = relaySecurityFromEnv({
      NODE_ENV: 'production',
      MODEL_RELAY_BASE_URL: 'https://relay.example.test/v1',
      MODEL_RELAY_ALLOWED_HOSTS: ' RELAY.EXAMPLE.TEST, ',
    })
    expect(policy).toEqual({ environment: 'production', allowedHosts: ['relay.example.test'] })
    await expect(assertRelayUrl('https://relay.example.test/v1', policy!)).resolves.toBeUndefined()
    await expect(assertRelayUrl('https://other.example.test/v1', policy!)).rejects.toThrow('HOST_NOT_ALLOWLISTED')
    await expect(assertRelayUrl('https://169.254.169.254/v1', { environment: 'production', allowedHosts: ['169.254.169.254'] }))
      .rejects.toThrow('PRIVATE_ADDRESS_BLOCKED')
  })

  it('supports explicit subdomain wildcards without allowing the wildcard apex', async () => {
    const policy = { environment: 'production', allowedHosts: ['*.relay.example.test'] }
    await expect(assertRelayUrl('https://tenant.relay.example.test/v1', policy)).resolves.toBeUndefined()
    await expect(assertRelayUrl('https://relay.example.test/v1', policy)).rejects.toThrow('HOST_NOT_ALLOWLISTED')
  })
})
