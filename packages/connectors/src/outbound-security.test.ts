import { describe, expect, it } from 'vitest'
import { assertOutboundUrl, inspectOutboundUrl } from './outbound-security.js'

/**
 * `PRIVATE_ADDRESS_BLOCKED` is the SSRF guard for every outbound endpoint this
 * package opens: the platform `api.baseUrl` and OAuth endpoints (where it is
 * the second line behind the host allowlist), the Vault address (where there is
 * no allowlist at all), and — through `assertOutboundUrl`'s DNS branch — a
 * hostname that resolves into a private range.
 *
 * The IPv6 half of it is the part that is easy to write against the wrong text:
 * a URL host is not what the caller typed. The WHATWG parser serializes an IPv6
 * literal into compressed hex and folds a dotted-quad tail into the last two
 * groups, so `https://[::ffff:127.0.0.1]/` reaches this module as
 * `[::ffff:7f00:1]`. A check that looked for the `::ffff:` prefix followed by a
 * dotted quad therefore never fired for any URL, and the loopback/link-local/
 * private address it names was admitted.
 */
const production = { environment: 'production' }

describe('outbound private address admission', () => {
  it('blocks an IPv4 address embedded in an IPv6 literal, however it is spelled', () => {
    // Every one of these addresses is private or link-local in its IPv4 form;
    // the URL parser rewrites each into hex, so the dotted spelling never
    // reaches the check.
    const embedded = new Map([
      ['https://[::ffff:127.0.0.1]/', '127.0.0.1 loopback'],
      ['https://[::ffff:169.254.169.254]/latest/meta-data/', 'cloud metadata (link-local)'],
      ['https://[::ffff:a9fe:a9fe]/', 'the same link-local address written in hex'],
      ['https://[::ffff:10.0.0.5]:8200/', 'RFC1918'],
      ['https://[::ffff:192.168.1.1]/', 'RFC1918'],
      ['https://[::ffff:100.64.0.1]/', 'carrier-grade NAT'],
      ['https://[::127.0.0.1]/', 'IPv4-compatible form'],
      ['https://[::ffff:0:169.254.169.254]/', 'the ::ffff:0:0/96 mapped range'],
      ['https://[0:0:0:0:0:ffff:169.254.169.254]/', 'uncompressed mapped form'],
    ])
    for (const [url, label] of embedded) {
      expect(inspectOutboundUrl(url, production), `${label} must be blocked (${url})`).toBe('PRIVATE_ADDRESS_BLOCKED')
    }
  })

  it('blocks the same addresses in their plain IPv4 spelling', () => {
    // The positive control for the rule above: if this stayed green while the
    // embedded form was admitted, the two spellings of one address disagreed.
    for (const url of ['https://127.0.0.1/', 'https://169.254.169.254/', 'https://10.0.0.5:8200/']) {
      expect(inspectOutboundUrl(url, production), `${url} must be blocked`).toBe('PRIVATE_ADDRESS_BLOCKED')
    }
  })

  it('still admits a mapped literal that names a public address', () => {
    // Guards the other direction: "block every address that contains ::" would
    // satisfy the cases above for the wrong reason.
    expect(inspectOutboundUrl('https://[::ffff:8.8.8.8]/', production)).toBeUndefined()
    expect(inspectOutboundUrl('https://[2606:4700::1111]/', production)).toBeUndefined()
  })

  it('refuses the embedded form at the DNS-rebinding re-check', async () => {
    // `assertOutboundUrl` returns early for an IP literal (there is nothing to
    // resolve), so the private check is the only thing standing between this
    // request and the metadata service.
    await expect(assertOutboundUrl('https://[::ffff:169.254.169.254]/', production)).rejects.toThrow('PRIVATE_ADDRESS_BLOCKED')
    await expect(assertOutboundUrl('https://[::ffff:127.0.0.1]/', production)).rejects.toThrow('PRIVATE_ADDRESS_BLOCKED')
    await expect(assertOutboundUrl('https://169.254.169.254/', production)).rejects.toThrow('PRIVATE_ADDRESS_BLOCKED')
  })
})
