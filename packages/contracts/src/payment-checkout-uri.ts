function isBlockedIpv4(host: string): boolean {
  if (!/^\d+(?:\.\d+){3}$/u.test(host)) return false
  const octets = host.split('.').map(Number)
  if (!octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return true
  const [a, b, c] = octets as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113) || a >= 224
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.invalid')) return true
  if (/^\d+(?:\.\d+){3}$/u.test(host)) return isBlockedIpv4(host)
  if (host.includes(':')) {
    // Only globally routable IPv6 unicast (2000::/3) is acceptable. This also
    // blocks loopback, link-local, ULA, unspecified, and IPv4-mapped literals.
    const first = Number.parseInt(host.split(':', 1)[0] || '0', 16)
    return !Number.isInteger(first) || first < 0x2000 || first > 0x3fff
  }
  // A single-label DNS name is commonly a private service-discovery target.
  return !host.includes('.')
}

/** Validate gateway-returned checkout URIs before exposing or persisting them. */
export type PaymentCheckoutChannel = 'wechat' | 'alipay'

/** Fixture checkout links are only valid in an explicitly enabled local/test path. */
export function isValidFixturePaymentCheckoutUri(raw: string): boolean {
  if (!raw || raw !== raw.trim() || /[\u0000-\u0020\u007f\\]/u.test(raw) || raw.includes('#')) return false
  try {
    const url = new URL(raw)
    return url.protocol === 'fixture:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash
  } catch { return false }
}

export function isValidPaymentCheckoutUri(raw: string, channel: PaymentCheckoutChannel): boolean {
  if (!raw || raw !== raw.trim() || /[\u0000-\u0020\u007f\\]/u.test(raw) || raw.includes('#')) return false
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (!url.hostname || url.username || url.password || url.hash) return false
  const authority = raw.slice(raw.indexOf('//') + 2).split(/[/?]/u, 1)[0] ?? ''
  if (authority.includes('@')) return false

  if (url.protocol === 'https:') return raw.startsWith('https://') && !isBlockedHost(url.hostname)
  if (url.protocol === 'weixin:') return channel === 'wechat' && raw.startsWith('weixin://')
    && url.hostname === 'wxpay' && url.pathname === '/bizpayurl' && Boolean(url.searchParams.get('pr')?.trim())
  if (url.protocol === 'alipays:') return channel === 'alipay' && raw.startsWith('alipays://')
    && url.hostname === 'platformapi' && url.pathname === '/startapp' && Boolean(url.searchParams.get('appId')?.trim())
  return false
}

export function assertValidPaymentCheckoutUri(raw: string, channel: PaymentCheckoutChannel): void {
  if (!isValidPaymentCheckoutUri(raw, channel)) throw new TypeError('paymentUrl must be a safe supported provider checkout URI for the selected channel')
}
