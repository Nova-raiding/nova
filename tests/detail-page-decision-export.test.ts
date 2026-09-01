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
  it('在草稿导出中保留 decisionContract，且不把未通过证据误报为 verified', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
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

    const jsonExport = JSON.parse(service.exportContent('ws_demo', version.id, 'json').body) as {
      body: { modules: Array<{ decisionContract?: { evidence: { status: EvidenceStatus } } }> }
    }
    const markdownExport = service.exportContent('ws_demo', version.id, 'markdown').body
    const bundle = service.exportContent('ws_demo', version.id, 'bundle')
    const files = readStoredZip(bundle.binaryBody ?? new Uint8Array())
    const contentJson = JSON.parse(requireFile(files, 'content.json')) as typeof jsonExport
    const contentMarkdown = requireFile(files, 'content.md')
    const sourceMap = JSON.parse(requireFile(files, 'source-map.json')) as {
      entries: Array<{ outputPath: string; field: string; factSourceIds: string[] }>
    }
    const compatibilitySourceMap = JSON.parse(requireFile(files, 'legacy-source-map.json')) as {
      modules: Record<string, { evidence_status?: EvidenceStatus }>
    }

    const exportedStatuses = jsonExport.body.modules.slice(0, 3).map(module => module.decisionContract?.evidence.status)
    expect(exportedStatuses).toEqual(statuses)
    expect(contentJson.body.modules.slice(0, 3).map(module => module.decisionContract?.evidence.status)).toEqual(statuses)
    for (const status of statuses) {
      expect(markdownExport).toContain(`证据状态：${status}`)
      expect(contentMarkdown).toContain(`证据状态：${status}`)
    }

    expect(sourceMap.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ outputPath: 'content.json', field: 'body', factSourceIds: expect.any(Array) }),
      expect.objectContaining({ outputPath: 'content.md', field: 'content', factSourceIds: expect.any(Array) }),
    ]))
    expect(Object.values(compatibilitySourceMap.modules).slice(0, 3).map(module => module.evidence_status)).toEqual(statuses)

    const unverifiedExports = JSON.stringify({ jsonExport, contentJson, sourceMap, compatibilitySourceMap })
    expect(unverifiedExports).toContain('仅验证导出契约，不代表生产发布成功')
    expect(JSON.stringify(sourceMap)).not.toContain('"evidence_status":"verified"')
    expect(Object.values(compatibilitySourceMap.modules).slice(0, 3)).not.toContainEqual(expect.objectContaining({ evidence_status: 'verified' }))
    expect(markdownExport).toContain('不代表平台已发布')
    expect(bundle.deliveryManifest?.publishReceipt).toBeUndefined()
  })
})
