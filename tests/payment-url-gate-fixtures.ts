// Shared negative corpus for ECS runtime and rendered production payment gates.
export const unsafePaymentUrls = [
  'https://0.0.0.0/query', 'https://0.1.2.3/query', 'https://100.64.0.1/query',
  'https://198.18.0.1/query', 'https://192.0.2.1/query', 'https://203.0.113.1/query',
  'https://224.0.0.1/query', 'https://255.255.255.255/query', 'https://[::]/query',
  'https://[2001:db8::1]/query', 'https://[::ffff:8.8.8.8]/query',
  'https://pay.yxsona.com/v1/../query', 'https://pay.yxsona.com/v1/%2e%2e/query',
  'https://PAY.YXSONA.COM/query', 'https://pay.yxsona.com:443/query',
  'https://0177.0.0.1/query', 'https://2130706433/query',
  ' https://pay.yxsona.com/query', 'https://pay.yxsona.com/query?',
  'https://pay.yxsona.com:0443/query', 'https://pay.yxsona.com:08443/query',
  'https://0x7f.0.0.1/query', 'https://192.0.0.1/query', 'https://192.88.99.1/query',
  'https://198.51.100.1/query', 'https://240.0.0.1/query', 'https://[fc00::1]/query',
  'https://[fe80::1]/query', 'https://[ff02::1]/query', 'https://[2002:808:808::1]/query',
  'https://[3fff::1]/query', 'https://[2001::1]/query',
] as const

export const safePaymentUrls = [
  'https://pay.yxsona.com/v1/query', 'https://pay.yxsona.com',
  'https://pay.yxsona.com:8443/v1/query', 'https://8.8.8.8/query',
  'https://[2606:4700:4700::1111]/query',
] as const
