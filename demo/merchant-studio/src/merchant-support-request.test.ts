import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMerchantSupportRequest, normalizeMerchantSupportReceipt, redactMerchantSupportText, submitMerchantSupportRequest } from './api'
import { MerchantSupportRequestPanel, supportDiagnostic } from './MerchantSupportRequestPanel'

const ticketId = '123e4567-e89b-12d3-a456-426614174000'
const receipt = { ticket_id: ticketId, ticket_number: 'SUP-20261005-001', status: 'open' as const, replayed: false, replies_path: `/v1/support/requests/${ticketId}`, submitted: true as const }
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } })

describe('merchant pre-order support is an actual receipt workflow', () => {
  beforeEach(() => vi.stubGlobal('window', globalThis))
  afterEach(() => vi.unstubAllGlobals())
  it('submits a first support request without requiring an order, task, or existing ticket; credentials are redacted', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { requests.push({ url, body: JSON.parse(String(init.body)) }); return envelope(receipt, 201) }))
    const actual = await submitMerchantSupportRequest('/api', { subject: '首购目录打不开', message: '访问失败 password=do-not-send Bearer abc.def', idempotency_key: 'support-intent-1', request_id: 'request-1', trace_id: 'trace-1', version: 'commercial.subscription.v1', step: '目录查询' })
    expect(actual).toMatchObject({ ticket_number: 'SUP-20261005-001', submitted: true })
    expect(requests[0].url).toBe('/api/v1/support/requests')
    expect(requests[0].body).toMatchObject({ request_id: 'request-1', trace_id: 'trace-1', idempotency_key: 'support-intent-1' })
    expect(JSON.stringify(requests[0].body)).not.toContain('do-not-send')
    expect(JSON.stringify(requests[0].body)).not.toContain('abc.def')
    expect(requests[0].body).not.toHaveProperty('order_id')
    expect(requests[0].body).not.toHaveProperty('customer_id')
  })
  it('preserves the original request key and body when an uncertain response is retried', async () => {
    const attempts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => { attempts.push(String(init.body)); return attempts.length === 1 ? new Response(JSON.stringify({ error: { code: 'SUPPORT_REQUEST_OUTCOME_UNKNOWN', message: '登记结果未知' } }), { status: 503 }) : envelope({ ...receipt, replayed: true }, 201) }))
    const intent = { subject: '首购页面错误', message: '目录尚未读取成功', idempotency_key: 'support-original-1' }
    await expect(submitMerchantSupportRequest('/api', intent)).rejects.toMatchObject({ code: 'SUPPORT_REQUEST_OUTCOME_UNKNOWN' })
    await expect(submitMerchantSupportRequest('/api', intent)).resolves.toMatchObject({ ticket_id: ticketId, replayed: true })
    expect(attempts[1]).toBe(attempts[0])
  })
  it('does not report success without a verified receipt or follow arbitrary reply URLs', () => {
    expect(() => normalizeMerchantSupportReceipt({ ...receipt, submitted: false } as never)).toThrow('尚未确认')
    expect(() => normalizeMerchantSupportReceipt({ ...receipt, replies_path: 'https://external.example/replies' })).toThrow()
  })
  it('queries replies through the authenticated fixed path and propagates cross-account denial', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { paths.push(url); return envelope({ ...receipt, subject: '目录问题', replies: [{ id: 'reply-1', body: '已恢复，请刷新', created_at: '2026-10-05T06:00:00Z' }] }) }))
    await expect(fetchMerchantSupportRequest('/api', ticketId)).resolves.toMatchObject({ replies: [{ body: '已恢复，请刷新' }] })
    expect(paths).toEqual([`/api/v1/support/requests/${ticketId}`])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'SUPPORT_REQUEST_NOT_FOUND', message: '不属于当前账号及企业' } }), { status: 404 })))
    await expect(fetchMerchantSupportRequest('/api', ticketId)).rejects.toMatchObject({ code: 'SUPPORT_REQUEST_NOT_FOUND' })
  })
  it('starts as unsubmitted with labeled fields, and shows an unavailable entry without pretending intake succeeded', () => {
    const html = renderToStaticMarkup(createElement(MerchantSupportRequestPanel, { baseUrl: '/api', workspaceKey: 'ws-1:user-1', handoff: { status: 'blocked', owner: '运营支持' } }))
    expect(html).toContain('问题标题')
    expect(html).toContain('问题说明')
    expect(html).toContain('当前未提交求助')
    expect(html).toContain('支持登记入口暂不可用')
    expect(html).not.toContain('SUP-20261005-001')
    expect(html).not.toContain('已登记真实工单')
  })
  it('only shares safe correlation fields and removes common secret patterns from question text', () => {
    expect(supportDiagnostic('request-123:phase_1')).toBe('request-123:phase_1')
    expect(supportDiagnostic('Bearer a-secret-token')).toBeUndefined()
    expect(supportDiagnostic('access_token=secret')).toBeUndefined()
    expect(supportDiagnostic('request-1\nsecret')).toBeUndefined()
    expect(redactMerchantSupportText('api_key=my-key https://example.test/?token=raw-token&safe=1')).not.toMatch(/my-key|raw-token/u)
  })
})
