import { describe, expect, it } from 'vitest'
import { contextEnvelopeHash } from '../../../packages/persistence/src/context-snapshot-repository.js'
import { assertGenerationInput } from './generation-input.js'
const envelope = { platform: 'taobao', outputType: 'plain_text', candidateOnly: true, directionId: 'A', product: { id: 'qa-shell', title: '内部QA' }, taskIntent: { constraints: '不补造库存', sourceAssets: [] }, usageContext: { workspaceId: 'ws_1', actionId: 'action_1', runKey: 'task_1' } }
describe('plain candidate frozen input', () => {
  it('retains absent facts and hash for the server-frozen candidate envelope', () => {
    const parsed = assertGenerationInput(envelope, 'ws_1', 'action_1', 'task_1')
    expect(parsed.product).toEqual(envelope.product)
    expect(parsed.confirmedFactSourceIds).toBeUndefined()
    expect(contextEnvelopeHash(parsed as unknown as Record<string, unknown>)).toBe(contextEnvelopeHash(envelope))
  })
  it.each([{ candidateOnly: false }, { outputType: 'detail_page_and_static_brief' }, { outputType: undefined }])('does not weaken required facts for other contracts: %j', override => {
    expect(() => assertGenerationInput({ ...envelope, ...override }, 'ws_1', 'action_1', 'task_1')).toThrow('product.stock')
  })
  it('keeps tenant/action/run binding mandatory', () => {
    expect(() => assertGenerationInput(envelope, 'other', 'action_1', 'task_1')).toThrow('usageContext')
  })
})
