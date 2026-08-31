import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { classifyAssetUpload, classifyAssetUploadBatch, type AssetUploadSecurityInput } from './asset-upload-security.js'

const utf8 = (value: string) => new TextEncoder().encode(value)
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('asset upload security', () => {
  it('allows a signature-consistent asset and emits a filename-hash-only audit payload', () => {
    const fileName = '客户甲-商品原图.png'
    const secretBody = new Uint8Array([...png, ...utf8('credential-in-file-body')])
    const result = classifyAssetUpload({ fileName, declaredMime: ' Image/PNG; charset=binary ', bytes: secretBody }, {
      workspaceId: 'workspace-1', actorId: 'actor-1', requestId: 'request-1',
    })

    expect(result).toMatchObject({ decision: 'allow', reasonCode: null, reasonCodes: [] })
    expect(result.audit).toEqual({
      workspace_id: 'workspace-1',
      actor_id: 'actor-1',
      request_id: 'request-1',
      file_name_sha256: createHash('sha256').update(fileName).digest('hex'),
      size_bytes: secretBody.byteLength,
      declared_mime: 'image/png',
      signature_class: 'png',
      decision: 'allow',
      reason_code: null,
    })
    expect(JSON.stringify(result.audit)).not.toContain(fileName)
    expect(JSON.stringify(result.audit)).not.toContain('credential-in-file-body')
  })

  it.each([
    ['PE', new Uint8Array([0x4d, 0x5a, 0x90, 0])],
    ['ELF', new Uint8Array([0x7f, 0x45, 0x4c, 0x46])],
    ['Mach-O', new Uint8Array([0xcf, 0xfa, 0xed, 0xfe])],
    ['fat Mach-O', new Uint8Array([0xca, 0xfe, 0xba, 0xbe])],
    ['shebang', utf8('#!/bin/sh\necho unsafe')],
  ])('rejects %s executable content regardless of a benign filename', (_label, bytes) => {
    const result = classifyAssetUpload({ fileName: 'preview.png', declaredMime: 'image/png', bytes })
    expect(result.reasonCodes).toContain('ASSET_EXECUTABLE_REJECTED')
    expect(result.decision).toBe('reject')
  })

  it('detects extension, MIME and content-signature disagreement independently', () => {
    const extensionMime = classifyAssetUpload({ fileName: 'photo.png', declaredMime: 'image/jpeg', bytes: png })
    expect(extensionMime.reasonCodes).toContain('ASSET_EXTENSION_MIME_MISMATCH')
    expect(extensionMime.reasonCodes).toContain('ASSET_MIME_SIGNATURE_MISMATCH')

    const contentSignature = classifyAssetUpload({ fileName: 'photo.jpg', declaredMime: 'image/jpeg', bytes: png })
    expect(contentSignature.reasonCodes).toContain('ASSET_EXTENSION_SIGNATURE_MISMATCH')
    expect(contentSignature.reasonCodes).toContain('ASSET_MIME_SIGNATURE_MISMATCH')
  })

  it.each(['invoice.pdf.png', 'photo.jpg.exe.png', 'guide.docx.pdf'])('rejects suspicious double extensions: %s', fileName => {
    expect(classifyAssetUpload({ fileName, declaredMime: 'image/png', bytes: png }).reasonCodes).toContain('ASSET_DOUBLE_EXTENSION_REJECTED')
  })

  it('keeps ordinary dotted version names and Chinese filenames valid', () => {
    expect(classifyAssetUpload({ fileName: '商品主图.v2.png', declaredMime: 'image/png', bytes: png }).decision).toBe('allow')
  })

  it.each([
    ['control character', 'safe\u202Egnp.exe.png', 'ASSET_FILENAME_CONTROL_CHARACTER'],
    ['NFKC confusable', 'photo．png', 'ASSET_FILENAME_UNICODE_CONFUSABLE'],
    ['mixed-script confusable', 'photо.png', 'ASSET_FILENAME_UNICODE_CONFUSABLE'],
  ])('rejects %s in filenames', (_label, fileName, reason) => {
    expect(classifyAssetUpload({ fileName, declaredMime: 'image/png', bytes: png }).reasonCodes).toContain(reason)
  })

  it.each([
    ['script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'ASSET_SVG_SCRIPT_REJECTED'],
    ['encoded javascript link', '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x73;cript:alert(1)"/></svg>', 'ASSET_SVG_SCRIPT_REJECTED'],
    ['external link', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://attacker.test/x.png"/></svg>', 'ASSET_SVG_EXTERNAL_REFERENCE_REJECTED'],
    ['relative external link', '<svg xmlns="http://www.w3.org/2000/svg"><image href="images/remote.png"/></svg>', 'ASSET_SVG_EXTERNAL_REFERENCE_REJECTED'],
    ['event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'ASSET_SVG_EVENT_HANDLER_REJECTED'],
    ['foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html</div></foreignObject></svg>', 'ASSET_SVG_FOREIGN_OBJECT_REJECTED'],
  ])('rejects SVG %s', (_label, svg, reason) => {
    const result = classifyAssetUpload({ fileName: 'vector.svg', declaredMime: 'image/svg+xml', bytes: utf8(svg) })
    expect(result.reasonCodes).toContain(reason)
    expect(result.audit.signature_class).toBe('svg')
  })

  it('allows a passive self-contained SVG', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path id="shape" d="M0 0h10v10z"/><use href="#shape"/></svg>'
    expect(classifyAssetUpload({ fileName: 'vector.svg', declaredMime: 'image/svg+xml', bytes: utf8(svg) }).decision).toBe('allow')
  })

  it('fails closed without throwing on an out-of-range SVG character reference', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#99999999;script:alert(1)"/></svg>'
    expect(() => classifyAssetUpload({ fileName: 'vector.svg', declaredMime: 'image/svg+xml', bytes: utf8(svg) })).not.toThrow()
    expect(classifyAssetUpload({ fileName: 'vector.svg', declaredMime: 'image/svg+xml', bytes: utf8(svg) }).decision).toBe('reject')
  })

  it('redacts unsafe audit scope values and never accepts arbitrary credential fields', () => {
    const scope = {
      workspaceId: 'workspace\r\nforged', actorId: 'Bearer actor-secret', requestId: 'request-safe', authorization: 'Bearer credential', cookie: 'session=secret', token: 'token-secret',
    }
    const audit = classifyAssetUpload({ fileName: 'private-customer-name.png', declaredMime: 'image/png', bytes: png }, scope).audit
    const serialized = JSON.stringify(audit)
    expect(audit).toMatchObject({ workspace_id: null, actor_id: null, request_id: 'request-safe' })
    for (const sensitive of ['private-customer-name', 'actor-secret', 'credential', 'session=secret', 'token-secret']) expect(serialized).not.toContain(sensitive)
  })

  it('returns an independent decision and audit payload for every batch item', () => {
    const inputs: AssetUploadSecurityInput[] = [
      { fileName: 'safe.png', declaredMime: 'image/png', bytes: png },
      { fileName: 'malware.png', declaredMime: 'image/png', bytes: new Uint8Array([0x4d, 0x5a, 0, 0]) },
      { fileName: 'also-safe.txt', declaredMime: 'text/plain', bytes: utf8('safe notes') },
    ]
    const results = classifyAssetUploadBatch(inputs, { workspaceId: 'workspace-batch', requestId: 'request-batch' })

    expect(results.map(result => result.decision)).toEqual(['allow', 'reject', 'allow'])
    expect(results).toHaveLength(inputs.length)
    expect(results.every(result => result.audit.workspace_id === 'workspace-batch' && result.audit.request_id === 'request-batch')).toBe(true)
    expect(results[1]?.reasonCodes).toContain('ASSET_EXECUTABLE_REJECTED')
  })
})
