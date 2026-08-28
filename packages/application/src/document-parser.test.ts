import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocumentFacts } from './document-parser.js'

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

describe('document parser', () => {
  it('extracts PDF text without an OCR claim', async () => {
    const facts = await parseDocumentFacts({ name: 'guide.pdf', mimeType: 'application/pdf', body: Buffer.from(pdfFixture) })
    expect(facts).toMatchObject({ format: 'pdf', pages: 1 })
    expect(String(facts.text)).toContain('Hello Codex')
  })

  it('extracts DOCX text as untrusted facts', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    zip.file('word/document.xml', '<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p><r><t>品牌定位</t></r></p></body></document>')
    const facts = await parseDocumentFacts({ name: 'brand.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: await zip.generateAsync({ type: 'uint8array' }) })
    expect(facts).toMatchObject({ format: 'docx' })
    expect(String(facts.text)).toContain('品牌定位')
  })

  it('extracts first-sheet XLSX rows and shared strings', async () => {
    const zip = new JSZip()
    zip.file('xl/sharedStrings.xml', '<sst><si><t>商品标题</t></si><si><t>轻量外套</t></si></sst>')
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>')
    const facts = await parseDocumentFacts({ name: 'products.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: await zip.generateAsync({ type: 'uint8array' }) })
    expect(facts).toMatchObject({ format: 'xlsx', rows: [{ A: '商品标题', B: '轻量外套' }] })
  })
})
