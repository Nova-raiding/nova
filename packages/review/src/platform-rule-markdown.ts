import { createHash } from 'node:crypto'

export interface ParsedPlatformRuleCard {
  packId: string
  name: string
  version: string
  platform: string
  scope: 'platform'
  status: 'draft'
  sourceKind: 'official'
  sourceReference: string
  sourceCheckedAt: string
  content: string
  checksum: string
}

const field = (body: string, label: string) => body.match(new RegExp(`^- ${label}：(.+)$`, 'mu'))?.[1]?.trim() ?? ''

/** Parse the reviewed `## PDD-*` card format without activating any rule. */
export function parsePlatformRuleMarkdown(markdown: string, importedAt = new Date().toISOString()): ParsedPlatformRuleCard[] {
  if (!markdown.trim()) return []
  const cards = [...markdown.matchAll(/^##\s+(PDD-[A-Z0-9-]+)｜(.+)$/gmu)]
  const documentVersion = markdown.match(/知识库\s+v([\w.-]+)/u)?.[1] ?? 'imported'
  return cards.map((match, index) => {
    const cardId = match[1] ?? 'UNKNOWN'
    const cardName = match[2]?.trim() ?? cardId
    const start = (match.index ?? 0) + match[0].length
    const end = cards[index + 1]?.index ?? markdown.length
    const body = markdown.slice(start, end).trim()
    const platformLabel = (field(body, '平台').split('；')[0] ?? '').trim()
    const platform = platformLabel === '拼多多' ? 'pinduoduo' : platformLabel
    if (!platform) throw new Error(`${cardId} 缺少平台字段`)
    const source = body.match(/^- 官方依据：(.+)$/mu)?.[1]?.trim() ?? ''
    if (!source) throw new Error(`${cardId} 缺少官方依据`)
    const content = `${cardId}｜${cardName}\n${body}`
    return {
      packId: `${platform.toLowerCase()}-manual-${cardId.toLowerCase()}`,
      name: cardName,
      version: documentVersion,
      platform,
      scope: 'platform',
      status: 'draft',
      sourceKind: 'official',
      sourceReference: source,
      sourceCheckedAt: importedAt,
      content,
      checksum: createHash('sha256').update(content).digest('hex'),
    }
  })
}
