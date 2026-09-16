export function countMerchantBridgeTools(source: string): number {
  const start = source.indexOf('const METHODS = {')
  const end = source.indexOf('\n}\n\n', start)
  const methods = start >= 0 && end > start ? source.slice(start, end) : ''
  const names = [...methods.matchAll(/^  '([^']+)'\s*:/gmu)].map(match => match[1]!)
  const disabledBlock = source.match(/const COMMERCIAL_DISABLED_METHODS = new Set\(\[(.*?)\]\)/su)?.[1] ?? ''
  const disabled = new Set([...disabledBlock.matchAll(/'([^']+)'/gu)].map(match => match[1]!))
  const hiddenBlock = source.match(/const MERCHANT_HIDDEN_METHODS = new Set\(\[(.*?)\]\)/su)?.[1] ?? ''
  const hidden = new Set([...hiddenBlock.matchAll(/'([^']+)'/gu)].map(match => match[1]!))
  return names.filter(name => !name.startsWith('ops.') && !hidden.has(name) && !disabled.has(name)).length
}
