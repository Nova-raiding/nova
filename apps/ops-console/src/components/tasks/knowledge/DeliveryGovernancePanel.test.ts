import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeliveryReadinessCards, deliveryLiveStatus, opsMediaReadiness } from './DeliveryGovernancePanel.js'

describe('ops delivery readiness', () => {
  it('does not show green without source, version and expiry', () => {
    expect(opsMediaReadiness({ ready: true, mediaReady: true, mediaEvidence: true, evidenceState: 'ready', sourceRef: 'evidence://canary', schemaVersion: 'v1', verifiedAt: '2026-08-01T00:00:00Z' }, Date.parse('2026-08-29T00:00:00Z'))).toBe('unverified')
  })
  it('distinguishes approved and expired evidence', () => {
    const base = { ready: true, mediaReady: true, mediaEvidence: true, evidenceState: 'ready', sourceRef: 'evidence://canary', schemaVersion: 'v1', verifiedAt: '2026-08-01T00:00:00Z' }
    expect(opsMediaReadiness({ ...base, expiresAt: '2026-09-01T00:00:00Z' }, Date.parse('2026-08-29T00:00:00Z'))).toBe('approved')
    expect(opsMediaReadiness({ ...base, expiresAt: '2026-08-01T00:00:00Z' }, Date.parse('2026-08-29T00:00:00Z'))).toBe('expired')
  })
  it('announces loading and fail-closed error states', () => {
    expect(deliveryLiveStatus(true, 'stale error', 6)).toBe('正在读取交付证据')
    expect(deliveryLiveStatus(false, 'timeout', 6)).toContain('缺失能力保持阻断')
    expect(deliveryLiveStatus(false, undefined, 6)).toBe('已读取 6 个平台的交付证据')
  })
  it('renders explicit API empty states without a success label', () => {
    const html = renderToStaticMarkup(createElement(DeliveryReadinessCards, { state: { loaded: true, loading: false, data: { generatedAt: '2026-08-29T00:00:00Z', status: 'unverified', dimensions: { mapping: 'unverified', bundles: 'unverified', authenticity: 'unverified' }, mappingPreflights: [], bundles: [], authenticity: [] } } }))
    expect(html).toContain('接口返回 0 条交付治理记录')
    expect(html).toContain('API 未返回 mapping preflight 记录')
    expect(html).toContain('API 未返回 manifest、文件哈希或 bundle verification')
    expect(html).not.toContain('已通过')
  })
  it('renders mapping findings and verified bundle hashes from API data', () => {
    const html = renderToStaticMarkup(createElement(DeliveryReadinessCards, { state: { loaded: true, loading: false, data: { generatedAt: '2026-08-29T00:00:00Z', status: 'blocked', dimensions: { mapping: 'blocked', bundles: 'passed', authenticity: 'unverified' }, mappingPreflights: [{ id: 'taobao:p-1', platform: 'taobao', productId: 'p-1', status: 'blocked', findings: [{ code: 'ENUM_CHANGED', message: '枚举已变化', nextAction: '重新执行 preflight' }] }], bundles: [{ id: 'v-1', taskId: 't-1', productId: 'p-1', status: 'passed', findings: [], verification: { valid: true, manifestHash: 'manifest-123', artifactSha256: 'sha256-123' } }], authenticity: [] } } }))
    expect(html).toContain('ENUM_CHANGED')
    expect(html).toContain('重新执行 preflight')
    expect(html).toContain('manifest-123')
    expect(html).toContain('sha256-123')
  })
  it('keeps a null or failed API response visibly unverified', () => {
    expect(renderToStaticMarkup(createElement(DeliveryReadinessCards, { state: { loaded: true, loading: false, data: null } }))).toContain('交付治理 API 返回空响应')
    expect(renderToStaticMarkup(createElement(DeliveryReadinessCards, { state: { loaded: true, loading: false, data: null, error: 'timeout' } }))).toContain('均保持未验证')
  })
})
