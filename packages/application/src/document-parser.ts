import JSZip from 'jszip'
import { extractRawText } from 'mammoth'
import { PDFParse } from 'pdf-parse'

export type ParsedDocumentFacts = Record<string, unknown>

export type ParseErrorContext = {
  code: 'unsupported_format' | 'invalid_document' | 'parser_failure'
  message: string
  location?: { page?: number; line?: number; column?: number; cell?: string }
  manualAction: 'asset.facts.confirm'
}

export class DocumentParseError extends Error {
  readonly context: ParseErrorContext

  constructor(context: ParseErrorContext) {
    super(context.message)
    this.name = 'DocumentParseError'
    this.context = context
  }
}

const MAX_EXTRACTED_TEXT = 2 * 1024 * 1024

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/gu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&')
}

function xmlText(xml: string): string {
  return decodeXml(xml.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim())
}

function parseDelimitedText(text: string): ParsedDocumentFacts {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  return Object.fromEntries(lines.map((line, index) => {
    const separator = line.indexOf(':') >= 0 ? line.indexOf(':') : line.indexOf('=')
    return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : [`line_${index + 1}`, line]
  }))
}

async function parseXlsx(bytes: Uint8Array): Promise<ParsedDocumentFacts> {
  const zip = await JSZip.loadAsync(bytes)
  const sharedXml = zip.file('xl/sharedStrings.xml') ? await zip.file('xl/sharedStrings.xml')!.async('text') : ''
  const sharedStrings = [...sharedXml.matchAll(/<si[\s\S]*?<\/si>/giu)].map(match => xmlText(match[0]))
  const sheetName = Object.keys(zip.files).find(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
  if (!sheetName) throw new Error('XLSX 缺少工作表')
  const sheetXml = await zip.file(sheetName)!.async('text')
  const rows = [...sheetXml.matchAll(/<row\b[\s\S]*?<\/row>/giu)].map(rowMatch => {
    const cells = [...rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/giu)].map(cellMatch => {
      const attributes = cellMatch[1] ?? ''
      const reference = /\br="([A-Z]+)\d+"/u.exec(attributes)?.[1] ?? ''
      const raw = /<v>([\s\S]*?)<\/v>/iu.exec(cellMatch[2] ?? '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/iu.exec(cellMatch[2] ?? '')?.[1] ?? ''
      const value = /\bt="s"/u.test(attributes) ? sharedStrings[Number(raw)] ?? '' : decodeXml(raw)
      return { reference, value }
    })
    return Object.fromEntries(cells.filter(cell => cell.reference).map(cell => [cell.reference, cell.value]))
  })
  return { format: 'xlsx', rows }
}

export async function parseDocumentFacts(input: { name: string; mimeType: string; body: Uint8Array }): Promise<ParsedDocumentFacts> {
  const name = input.name.toLowerCase()
  const mime = input.mimeType.toLowerCase()
  if (mime.includes('json') || name.endsWith('.json')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(input.body))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'JSON 文档无效'
      const position = /position (\d+)/u.exec(message)?.[1]
      throw new DocumentParseError({ code: 'invalid_document', message, ...(position ? { location: { column: Number(position) + 1 } } : {}), manualAction: 'asset.facts.confirm' })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 根节点必须是对象')
    return parsed as ParsedDocumentFacts
  }
  if (mime.startsWith('text/') || /\.(csv|txt|md)$/u.test(name)) return parseDelimitedText(new TextDecoder().decode(input.body))
  if (mime.includes('spreadsheet') || mime.includes('excel') || /\.(xlsx|xls)$/u.test(name)) return parseXlsx(input.body)
  if (mime.includes('wordprocessingml') || mime.includes('msword') || /\.(docx|doc)$/u.test(name)) {
    const result = await extractRawText({ buffer: Buffer.from(input.body) })
    return { format: 'docx', text: result.value.slice(0, MAX_EXTRACTED_TEXT), ...(result.messages.length ? { parserMessages: result.messages.map(message => message.message) } : {}) }
  }
  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    const parser = new PDFParse({ data: input.body })
    try {
      const result = await parser.getText()
      return { format: 'pdf', text: result.text.slice(0, MAX_EXTRACTED_TEXT), pages: result.total }
    } finally {
      await parser.destroy()
    }
  }
  throw new DocumentParseError({ code: 'unsupported_format', message: '当前文件格式不支持结构化解析；图片 OCR、扫描 PDF 和 AI/EPS 需要配置外部解析器', manualAction: 'asset.facts.confirm' })
}
