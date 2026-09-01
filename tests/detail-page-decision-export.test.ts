import { describe, expect, it } from 'vitest'
import { MerchantService } from '../packages/application/src/service.js'
import type { ContentModule } from '../packages/domain/src/index.js'

type EvidenceStatus = NonNullable<ContentModule['decisionContract']>['evidence']['status']

function readStoredZip(input: Uint8Array): Map<string, string> {
  const bytes = Buffer.from(input)
  const files = new Map<string, string>()
  let offset = 0

  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8)
    if (method !== 0) throw new Error(`unsupported ZIP compression method ${method}`)
    const size = bytes.readUInt32LE(offset + 18)
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + size
    if (dataEnd > bytes.length) throw new Error('truncated ZIP entry')
    files.set(bytes.subarray(nameStart, nameStart + nameLength).toString('utf8'), bytes.subarray(dataStart, dataEnd).toString('utf8'))
    offset = dataEnd
  }

  return files
}

function requireFile(files: ReadonlyMap<string, string>, path: string): string {
  const content = files.get(path)
  if (content === undefined) throw new Error(`delivery bundle is missing ${path}`)
  return content
}

describe('详情页决策证据导出契约', () => {
  it('保留已验证 decisionContract，并拒绝导出未通过证据', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    const verifiedJsonExport = JSON.parse(service.exportContent('ws_demo', version.id, 'json').body) as {
      body: { modules: Array<{ decisionContract?: { optional: boolean; evidence: { status: EvidenceStatus } } }> }
    }
    const verifiedMarkdownExport = service.exportContent('ws_demo', version.id, 'markdown').body
    const verifiedBundle = service.exportContent('ws_demo', version.id, 'bundle')
    const verifiedFiles = readStoredZip(verifiedBundle.binaryBody ?? new Uint8Array())
    const verifiedContentJson = JSON.parse(requireFile(verifiedFiles, 'content.json')) as typeof verifiedJsonExport

    const exportedContracts = verifiedJsonExport.body.modules.flatMap(module => module.decisionContract ? [module.decisionContract] : [])
    const bundledContracts = verifiedContentJson.body.modules.flatMap(module => module.decisionContract ? [module.decisionContract] : [])
    expect(exportedContracts.length).toBeGreaterThan(0)
    expect(bundledContracts.length).toBe(exportedContracts.length)
    expect(exportedContracts.every(contract => contract.evidence.status === 'verified'
      || (contract.optional && contract.evidence.status === 'missing'))).toBe(true)
    expect(bundledContracts.every(contract => contract.evidence.status === 'verified'
      || (contract.optional && contract.evidence.status === 'missing'))).toBe(true)
    expect(verifiedMarkdownExport).toContain('证据状态：verified')
    expect(verifiedMarkdownExport).toContain('不代表平台已发布')
    expect(verifiedBundle.deliveryManifest?.publishReceipt).toBeUndefined()

    const statuses: readonly EvidenceStatus[] = ['missing', 'conflict', 'expired']
    const modules = (version.body.modules ?? []).map((module, index) => {
      const status = statuses[index]
      if (!status || !module.decisionContract) return module
      return {
        ...module,
        contentKind: 'pending' as const,
        pendingReason: `mock ${status} evidence must remain unverified`,
        decisionContract: {
          ...module.decisionContract,
          claim: {
            ...module.decisionContract.claim,
            limitations: [...module.decisionContract.claim.limitations, '仅验证导出契约，不代表生产发布成功'],
          },
          evidence: {
            ...module.decisionContract.evidence,
            sourceIds: status === 'missing' ? [] : [...module.decisionContract.claim.factSourceIds],
            status,
          },
        },
      }
    })
    service.contentVersions.set(version.id, { ...version, body: { ...version.body, modules } })

    for (const format of ['json', 'markdown', 'bundle'] as const) {
      expect(() => service.exportContent('ws_demo', version.id, format))
        .toThrow('内容在导出前重新审核发现阻断项')
    }
  })
})
