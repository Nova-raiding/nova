import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { decodeZipFilename, parseDocumentFacts, truncateUtf8ToByteLength } from './document-parser.js'

const pdfFixture = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 18 Tf 20 100 Td (Hello Codex) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`

function forgeExpandedSizeToCompressed(bytes: Uint8Array, targetName: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset <= bytes.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (name !== targetName) { offset += 45 + nameLength + extraLength + commentLength; continue }
    const compressedSize = view.getUint32(offset + 20, true)
    const localOffset = view.getUint32(offset + 42, true)
    view.setUint32(offset + 24, compressedSize, true)
    view.setUint32(localOffset + 22, compressedSize, true)
    return true
  }
  return false
}

function padCompressedEntry(bytes: Uint8Array, targetName: string, size: number): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset <= bytes.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (name !== targetName) { offset += 45 + nameLength + extraLength + commentLength; continue }
    const localOffset = view.getUint32(offset + 42, true)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const oldSize = view.getUint32(offset + 20, true)
    if (size <= oldSize) return undefined
    const centralOffset = view.getUint32(bytes.byteLength - 22 + 16, true)
    const padding = size - oldSize
    const expanded = new Uint8Array(bytes.byteLength + padding)
    expanded.set(bytes.subarray(0, dataStart + oldSize))
    expanded.set(bytes.subarray(dataStart + oldSize, centralOffset), dataStart + oldSize + padding)
    expanded.set(bytes.subarray(centralOffset), centralOffset + padding)
    const expandedView = new DataView(expanded.buffer)
    const newCentralOffset = centralOffset + padding
    expandedView.setUint32(localOffset + 18, size, true)
    expandedView.setUint32(offset + padding + 20, size, true)
    expandedView.setUint32(expanded.byteLength - 22 + 16, newCentralOffset, true)
    return expanded
  }
  return undefined
}

describe('document parser', () => {
  it('truncates UTF-8 only at complete code point boundaries', () => {
    expect(truncateUtf8ToByteLength('😀tail', 3)).toBe('')
    expect(truncateUtf8ToByteLength('A😀tail', 4)).toBe('A')
    expect(truncateUtf8ToByteLength('A😀tail', 5)).toBe('A😀')
  })

  it('decodes legacy ZIP entry names as CP437 and flagged names as UTF-8', () => {
    expect(decodeZipFilename(Uint8Array.of(0x82), 0)).toBe('é')
    expect(decodeZipFilename(Uint8Array.of(0xc3, 0xa9), 0x0800)).toBe('é')
    expect(() => decodeZipFilename(Uint8Array.of(0xc3), 0x0800)).toThrow()
  })

  it('extracts PDF text without an OCR claim', async () => {
    const facts = await parseDocumentFacts({ name: 'guide.pdf', mimeType: 'application/pdf', body: Buffer.from(pdfFixture) })
    expect(facts).toMatchObject({ format: 'pdf', pages: 1 })
    expect(String(facts.text)).toContain('Hello Codex')
  })

  it('fails closed when PDF text would exceed the extraction limit', async () => {
    const cap = 2 * 1024 * 1024
    const textFragment = 'BT /F1 8 Tf 10 10 Td (AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) Tj ET '
    const completeFragments = Math.floor((cap - 2) / 48)
    const remainingAscii = cap - 2 - completeFragments * 48
    const pageText = textFragment.repeat(completeFragments)
    const stream = `${pageText} BT /F1 8 Tf 10 10 Td (${ 'A'.repeat(remainingAscii) }) Tj <FEFFD83DDE00> Tj ET`
    const secondPage = 'BT /F1 8 Tf 10 10 Td (SECOND PAGE MUST NOT BE EXTRACTED) Tj ET'
    const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream
${stream}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 7 0 R >> endobj
7 0 obj << /Length ${Buffer.byteLength(secondPage)} >> stream ${secondPage}
endstream endobj
trailer << /Root 1 0 R >>
%%EOF`
    await expect(parseDocumentFacts({ name: 'large.pdf', mimeType: 'application/pdf', body: Buffer.from(pdf) }))
      .rejects.toMatchObject({ name: 'DocumentParseError', context: {
        code: 'invalid_document', manualAction: 'asset.facts.confirm', message: expect.stringContaining('未返回不完整事实'),
      } })
  }, 30_000)

  it('extracts DOCX text through the bounded ZIP reader', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    zip.file('word/document.xml', '<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p><r><t>品牌定位</t></r></p></body></document>')
    const facts = await parseDocumentFacts({ name: 'brand.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: await zip.generateAsync({ type: 'uint8array' }) })
    expect(facts).toMatchObject({ format: 'docx' })
    expect(String(facts.text)).toContain('品牌定位')
  })

  it('ignores oversized unparsed DOCX media while bounding entries actually inflated for text', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
    zip.file('word/document.xml', '<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p><r><t>小文件正文</t></r></p></body></document>')
    zip.file('word/media/large.png', Buffer.alloc(9 * 1024 * 1024), { compression: 'STORE' })
    const body = await zip.generateAsync({ type: 'uint8array' })
    const facts = await parseDocumentFacts({ name: 'media.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body })
    expect(facts).toMatchObject({ format: 'docx' })
    expect(String(facts.text)).toContain('小文件正文')
  })

  it('ignores oversized compressed unparsed DOCX media while bounding parsed entries', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', '<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p><r><t>小文件正文</t></r></p></body></document>')
    // Stored incompressible-ish payload crosses the per-entry compressed-input
    // limit while remaining below the 50 MiB document-input limit.
    zip.file('word/media/large.bin', Buffer.alloc(17 * 1024 * 1024, 0x5a), { compression: 'STORE' })
    const body = await zip.generateAsync({ type: 'uint8array' })
    const facts = await parseDocumentFacts({ name: 'large-media.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body })
    expect(facts).toMatchObject({ format: 'docx' })
    expect(String(facts.text)).toContain('小文件正文')
  })

  it('rejects oversized compressed DOCX entries before extracting document text', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', `<document>${'A'.repeat(8 * 1024 * 1024 + 1)}</document>`)
    const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } })
    expect(body.byteLength).toBeLessThan(100_000)
    await expect(parseDocumentFacts({ name: 'bomb.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body }))
      .rejects.toThrow('ZIP 单个条目解压尺寸超过上限')
  })

  it('rejects ZIP64 packages instead of trusting unsupported expanded-size metadata', async () => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', '<worksheet/>')
    const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    // An archive that advertises a ZIP64-sized entry must not reach the inflator.
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    for (let offset = 0; offset <= body.byteLength - 46; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) { view.setUint32(offset + 24, 0xffffffff, true); break }
    }
    await expect(parseDocumentFacts({ name: 'zip64.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body }))
      .rejects.toThrow('不支持多卷或 ZIP64 文档')
  })

  it('rejects ZIP archives above the compressed input budget before parsing the directory', async () => {
    const body = new Uint8Array(50 * 1024 * 1024 + 1)
    await expect(parseDocumentFacts({ name: 'oversized.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body }))
      .rejects.toThrow('文档输入超过解析上限')
    await expect(parseDocumentFacts({ name: 'oversized.pdf', mimeType: 'application/pdf', body }))
      .rejects.toThrow('文档输入超过解析上限')
  })

  it('rejects a ZIP entry above the per-entry compressed input budget before inflating it', async () => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', '<worksheet/>')
    const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    const oversized = padCompressedEntry(body, 'xl/worksheets/sheet1.xml', 16 * 1024 * 1024 + 1)
    expect(oversized).toBeDefined()
    await expect(parseDocumentFacts({ name: 'oversized-entry.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: oversized! }))
      .rejects.toThrow('ZIP 单个条目压缩输入超过上限')
  })

  it('caps actual XLSX inflate output when the central directory advertises a smaller size', async () => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', `<worksheet>${'A'.repeat(8 * 1024 * 1024 + 1)}</worksheet>`)
    const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } })
    expect(forgeExpandedSizeToCompressed(body, 'xl/worksheets/sheet1.xml')).toBe(true)
    await expect(parseDocumentFacts({ name: 'forged-size.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body }))
      .rejects.toThrow('ZIP 实际解压输出超过上限')
  })

  it('caps actual DOCX inflate output when the central directory advertises a smaller size', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', `<document>${'A'.repeat(8 * 1024 * 1024 + 1)}</document>`)
    const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } })
    expect(forgeExpandedSizeToCompressed(body, 'word/document.xml')).toBe(true)
    await expect(parseDocumentFacts({ name: 'forged-size.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body }))
      .rejects.toThrow('ZIP 实际解压输出超过上限')
  })

  it('extracts first-sheet XLSX rows and shared strings', async () => {
    const zip = new JSZip()
    zip.file('xl/sharedStrings.xml', '<sst><si><t>商品标题</t></si><si><t>轻量外套</t></si></sst>')
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>')
    const facts = await parseDocumentFacts({ name: 'products.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await zip.generateAsync({ type: 'uint8array' }) })
    expect(facts).toMatchObject({ format: 'xlsx', rows: [{ A: '商品标题', B: '轻量外套' }] })
  })

  it('reads namespace-prefixed XLSX cells produced by standard workbook writers', async () => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="str"><x:v>平台</x:v></x:c><x:c r="B1" t="str"><x:v>商品名称</x:v></x:c></x:row><x:row r="2"><x:c r="A2" t="str"><x:v>jd</x:v></x:c><x:c r="C2" s="1" /><x:c r="B2" t="str"><x:v>外套</x:v></x:c></x:row></x:sheetData></x:worksheet>')
    const facts = await parseDocumentFacts({ name: 'products.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await zip.generateAsync({ type: 'uint8array' }) })
    expect(facts).toMatchObject({ format: 'xlsx', rows: [{ A: '平台', B: '商品名称' }, { A: 'jd', B: '外套' }] })
  })

  it('expands vertical merged product fields over SKU rows while preserving blank row positions', async () => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="str"><v>平台</v></c><c r="B1" t="str"><v>商品名称</v></c><c r="C1" t="str"><v>SKU名称</v></c></row><row r="2"><c r="A2" t="str"><v>淘宝</v></c><c r="B2" t="str"><v>大衣</v></c><c r="C2" t="str"><v>黑色</v></c></row><row r="3"><c r="C3" t="str"><v>白色</v></c></row><row r="5"><c r="A5" t="str"><v>京东</v></c></row></sheetData><mergeCells count="2"><mergeCell ref="A2:A3"/><mergeCell ref="B2:B3"/></mergeCells></worksheet>')
    const facts = await parseDocumentFacts({ name: 'merged.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await zip.generateAsync({ type: 'uint8array' }) })
    expect(facts).toMatchObject({ format: 'xlsx', rows: [
      { A: '平台', B: '商品名称', C: 'SKU名称' },
      { A: '淘宝', B: '大衣', C: '黑色' },
      { A: '淘宝', B: '大衣', C: '白色' },
      {},
      { A: '京东' },
    ] })
  })

  it.each(['100001', '999999999999999999999999999999'])('rejects an XLSX row coordinate outside the supported bound: %s', async row => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="${row}"><c r="A${row}" t="str"><v>attacker</v></c></row></sheetData></worksheet>`)
    await expect(parseDocumentFacts({ name: 'sparse.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await zip.generateAsync({ type: 'uint8array' }) }))
      .rejects.toThrow('XLSX 行号超出支持范围')
  })

  it('rejects an oversized vertical merge before expanding sparse worksheet rows', async () => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>attacker</v></c></row></sheetData><mergeCells><mergeCell ref="A1:A100001"/></mergeCells></worksheet>')
    await expect(parseDocumentFacts({ name: 'merged-bomb.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await zip.generateAsync({ type: 'uint8array' }) }))
      .rejects.toThrow('XLSX 行号超出支持范围')
  })

  it('bounds cumulative merge expansion across individually valid ranges', async () => {
    const zip = new JSZip()
    const merges = ['A1:A60001', 'B1:B60001'].map(ref => `<mergeCell ref="${ref}"/>`).join('')
    zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>attacker</v></c><c r="B1" t="str"><v>attacker</v></c></row></sheetData><mergeCells>${merges}</mergeCells></worksheet>`)
    await expect(parseDocumentFacts({ name: 'merge-work.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await zip.generateAsync({ type: 'uint8array' }) }))
      .rejects.toThrow('XLSX 合并单元格展开量超过上限')
  })

  it('rejects XLSX merge expansion that would exceed the serialized-facts byte budget', async () => {
    const zip = new JSZip()
    const largeValue = 'A'.repeat(700_000)
    zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>${largeValue}</v></c></row></sheetData><mergeCells><mergeCell ref="A1:A4"/></mergeCells></worksheet>`)
    await expect(parseDocumentFacts({ name: 'merge-output-bomb.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await zip.generateAsync({ type: 'uint8array' }) }))
      .rejects.toThrow('XLSX 结构化事实超过解析上限')
  })
})
