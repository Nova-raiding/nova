import { extractRawText } from 'mammoth'
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { inflateRawSync } from 'node:zlib'

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
// Match the largest supported MCP asset upload. ZIP inflation is synchronous,
// so bound both total compressed input and each individual DEFLATE call.
const MAX_DOCUMENT_INPUT_BYTES = 50 * 1024 * 1024
const MAX_PDF_PAGES = 500
const MAX_ZIP_COMPRESSED_ENTRY_BYTES = 16 * 1024 * 1024
// XLSX/DOCX are ZIP containers. Bound declared and actual expansion before
// parsing XML or passing entries to Mammoth.
const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_ZIP_EXPANDED_BYTES = 16 * 1024 * 1024
const MAX_ZIP_ENTRIES = 10_000
// Keep sparse/malformed worksheet coordinates from expanding into unbounded
// arrays, and cap the work spent materializing merged cells.
const MAX_XLSX_ROWS = 100_000
const MAX_XLSX_MERGE_EXPANSIONS = 100_000

export function truncateUtf8ToByteLength(value: string, byteLimit: number): string {
  if (byteLimit <= 0) return ''
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= byteLimit) return value
  let end = byteLimit
  while (end > 0) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, end)) }
    catch { end -= 1 }
  }
  return ''
}

type ZipEntry = { name: string; method: number; flags: number; crc32: number; compressedSize: number; expandedSize: number; localOffset: number; centralOffset: number }

const CP437_HIGH = Array.from('ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ')

/** Decode ZIP names according to the UTF-8 flag or the legacy CP437 default. */
export function decodeZipFilename(bytes: Uint8Array, flags: number): string {
  if ((flags & 0x0800) !== 0) return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Array.from(bytes, byte => byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]!).join('')
}

function zipError(message: string): never { throw new Error(message) }

function preflightZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const signature = 0x02014b50
  // EOCD is at most 65,557 bytes from EOF (including its comment).
  const searchStart = Math.max(0, bytes.byteLength - 65_557)
  let eocd = -1
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 <= bytes.byteLength
      && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error('ZIP 文档缺少有效目录')
  const disk = view.getUint16(eocd + 4, true)
  const centralDisk = view.getUint16(eocd + 6, true)
  const entriesOnDisk = view.getUint16(eocd + 8, true)
  const entryCount = view.getUint16(eocd + 10, true)
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('不支持多卷或 ZIP64 文档')
  }
  if (entryCount > MAX_ZIP_ENTRIES || centralOffset + centralSize !== eocd) {
    throw new Error('ZIP 文档目录超出支持范围')
  }
  let offset = centralOffset
  const entries = new Map<string, ZipEntry>()
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralOffset + centralSize || view.getUint32(offset, true) !== signature) throw new Error('ZIP 文档目录无效')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const crc32 = view.getUint32(offset + 16, true)
    const compressed = view.getUint32(offset + 20, true)
    const expanded = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const startDisk = view.getUint16(offset + 34, true)
    const localOffset = view.getUint32(offset + 42, true)
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength
    if (recordEnd > centralOffset + centralSize) throw new Error('ZIP 文档目录无效')
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    let name: string
    try { name = decodeZipFilename(nameBytes, flags) }
    catch { throw new Error('ZIP 条目文件名无效') }
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || entries.has(name)) throw new Error('ZIP 条目路径无效或重复')
    let extraOffset = offset + 46 + nameLength
    while (extraOffset < offset + 46 + nameLength + extraLength) {
      if (extraOffset + 4 > offset + 46 + nameLength + extraLength) throw new Error('ZIP 扩展字段无效')
      const fieldId = view.getUint16(extraOffset, true)
      const fieldLength = view.getUint16(extraOffset + 2, true)
      extraOffset += 4
      if (extraOffset + fieldLength > offset + 46 + nameLength + extraLength) throw new Error('ZIP 扩展字段无效')
      if (fieldId === 0x0001) throw new Error('不支持多卷或 ZIP64 文档')
      extraOffset += fieldLength
    }
    if (expanded === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff || startDisk !== 0) throw new Error('不支持多卷或 ZIP64 文档')
    if ((flags & ~0x080e) !== 0 || ![0, 8].includes(method)) throw new Error('ZIP 标志、加密方式或压缩算法不受支持')
    if (localOffset + 30 > centralOffset) throw new Error('ZIP 本地条目偏移无效')
    entries.set(name, { name, method, flags, crc32, compressedSize: compressed, expandedSize: expanded, localOffset, centralOffset })
    offset = recordEnd
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP 文档目录长度无效')
  const localRanges: Array<{ start: number; end: number }> = []
  for (const entry of entries.values()) {
    const local = entry.localOffset
    if (local + 30 > centralOffset || view.getUint32(local, true) !== 0x04034b50) throw new Error('ZIP 本地条目偏移或标头无效')
    const localFlags = view.getUint16(local + 6, true), localMethod = view.getUint16(local + 8, true)
    const nameLength = view.getUint16(local + 26, true), extraLength = view.getUint16(local + 28, true)
    if (localFlags !== entry.flags || localMethod !== entry.method) throw new Error('ZIP 本地条目元数据不一致')
    const localName = decodeZipFilename(bytes.subarray(local + 30, local + 30 + nameLength), entry.flags)
    if (localName !== entry.name) throw new Error('ZIP 本地条目名称不一致')
    const localExtraStart = local + 30 + nameLength
    const localExtraEnd = localExtraStart + extraLength
    if (localExtraEnd > centralOffset) throw new Error('ZIP 本地扩展字段越界')
    for (let extra = localExtraStart; extra < localExtraEnd;) {
      if (extra + 4 > localExtraEnd) throw new Error('ZIP 本地扩展字段无效')
      const fieldId = view.getUint16(extra, true), fieldLength = view.getUint16(extra + 2, true)
      extra += 4
      if (extra + fieldLength > localExtraEnd) throw new Error('ZIP 本地扩展字段无效')
      if (fieldId === 0x0001) throw new Error('不支持多卷或 ZIP64 文档')
      extra += fieldLength
    }
    if ((entry.flags & 0x0008) === 0) {
      if (view.getUint32(local + 14, true) !== entry.crc32 || view.getUint32(local + 18, true) !== entry.compressedSize
        || view.getUint32(local + 22, true) !== entry.expandedSize) throw new Error('ZIP 本地条目尺寸与目录不一致')
    }
    const dataStart = localExtraEnd
    const dataEnd = dataStart + entry.compressedSize
    let recordEnd = dataEnd
    if ((entry.flags & 0x0008) !== 0) {
      if (recordEnd + 12 > centralOffset) throw new Error('ZIP 数据描述符越界')
      if (recordEnd + 4 <= centralOffset && view.getUint32(recordEnd, true) === 0x08074b50) recordEnd += 4
      if (recordEnd + 12 > centralOffset) throw new Error('ZIP 数据描述符越界')
      if (view.getUint32(recordEnd, true) !== entry.crc32 || view.getUint32(recordEnd + 4, true) !== entry.compressedSize
        || view.getUint32(recordEnd + 8, true) !== entry.expandedSize) throw new Error('ZIP 数据描述符与目录不一致')
      recordEnd += 12
    }
    if (dataStart > dataEnd || recordEnd > centralOffset) throw new Error('ZIP 压缩数据越界')
    localRanges.push({ start: local, end: recordEnd })
  }
  localRanges.sort((a, b) => a.start - b.start)
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index]!.start < localRanges[index - 1]!.end) throw new Error('ZIP 本地条目范围重叠')
  }
  return entries
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  return crc >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function readZipEntry(bytes: Uint8Array, entry: ZipEntry, expandedBudget: { used: number }): Uint8Array {
  // Only entries that are actually inflated for parsing consume this budget.
  if (entry.compressedSize > MAX_ZIP_COMPRESSED_ENTRY_BYTES) throw new Error('ZIP 单个条目压缩输入超过上限')
  if (entry.expandedSize > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP 单个条目解压尺寸超过上限')
  if (entry.expandedSize + expandedBudget.used > MAX_ZIP_EXPANDED_BYTES) throw new Error('ZIP 总解压尺寸超过上限')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const start = entry.localOffset
  if (view.getUint32(start, true) !== 0x04034b50) throw new Error('ZIP 本地条目标头无效')
  const flags = view.getUint16(start + 6, true)
  const method = view.getUint16(start + 8, true)
  const nameLength = view.getUint16(start + 26, true)
  const extraLength = view.getUint16(start + 28, true)
  if (flags !== entry.flags || method !== entry.method) throw new Error('ZIP 本地条目元数据不一致')
  const localName = decodeZipFilename(bytes.subarray(start + 30, start + 30 + nameLength), entry.flags)
  if (localName !== entry.name) throw new Error('ZIP 本地条目名称不一致')
  const dataStart = start + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > entry.centralOffset) throw new Error('ZIP 压缩数据越界')
  const compressed = bytes.subarray(dataStart, dataEnd)
  const outputLimit = Math.min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_EXPANDED_BYTES - expandedBudget.used)
  if (outputLimit < 0 || (entry.method === 0 && compressed.byteLength > outputLimit)) throw new Error('ZIP 实际解压输出超过上限')
  let expanded: Uint8Array
  try {
    expanded = entry.method === 0
      ? Uint8Array.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: outputLimit + 1 })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error('ZIP 实际解压输出超过上限')
    }
    throw new Error('ZIP 压缩数据无效')
  }
  if (expanded.byteLength > MAX_ZIP_ENTRY_BYTES || expanded.byteLength + expandedBudget.used > MAX_ZIP_EXPANDED_BYTES) {
    throw new Error('ZIP 实际解压输出超过上限')
  }
  if (expanded.byteLength !== entry.expandedSize || crc32(expanded) !== entry.crc32) throw new Error('ZIP 实际内容与目录声明不一致')
  expandedBudget.used += expanded.byteLength
  return expanded
}

function xlsxRowNumber(value: string | undefined, fallback: number): number {
  const rowNumber = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_XLSX_ROWS) {
    throw new Error(`XLSX 行号超出支持范围（1–${MAX_XLSX_ROWS}）`)
  }
  return rowNumber
}

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

function parseCsvRows(text: string): ParsedDocumentFacts {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1 }
      else quoted = !quoted
    } else if (character === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell); cell = ''
      if (row.some(value => value.trim())) rows.push(row)
      row = []
    } else cell += character
  }
  if (cell || row.length) { row.push(cell); if (row.some(value => value.trim())) rows.push(row) }
  if (rows.length < 2) throw new Error('CSV 必须包含表头和至少一行数据')
  const header = rows[0]!.map(value => value.normalize('NFKC').trim())
  return { format: 'csv', rows: rows.map(values => Object.fromEntries(header.map((name, index) => [name || `column_${index + 1}`, values[index] ?? '']))) }
}

async function parseXlsx(bytes: Uint8Array): Promise<ParsedDocumentFacts> {
  const zipEntries = preflightZip(bytes)
  const budget = { used: 0 }
  const sharedEntry = zipEntries.get('xl/sharedStrings.xml')
  const sharedXml = sharedEntry ? new TextDecoder('utf-8', { fatal: true }).decode(readZipEntry(bytes, sharedEntry, budget)) : ''
  const sharedStrings = [...sharedXml.matchAll(/<(?:[\w.-]+:)?si\b[\s\S]*?<\/(?:[\w.-]+:)?si>/giu)].map(match => xmlText(match[0]))
  const sheetEntry = [...zipEntries.values()].find(entry => /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name))
  if (!sheetEntry) throw new Error('XLSX 缺少工作表')
  const sheetXml = new TextDecoder('utf-8', { fatal: true }).decode(readZipEntry(bytes, sheetEntry, budget))
  const rowsByNumber = new Map<number, Record<string, string>>()
  let lastRow = 0
  let rowIndex = 0
  for (const rowMatch of sheetXml.matchAll(/<(?:[\w.-]+:)?row\b([^>]*)>[\s\S]*?<\/(?:[\w.-]+:)?row>/giu)) {
    rowIndex += 1
    if (rowIndex > MAX_XLSX_ROWS) throw new Error(`XLSX 工作表行数超过上限（${MAX_XLSX_ROWS}）`)
    const rowNumber = xlsxRowNumber(/\br="(\d+)"/u.exec(rowMatch[1] ?? '')?.[1], rowIndex)
    lastRow = Math.max(lastRow, rowNumber)
    const cells = [...rowMatch[0].matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/(?:[\w.-]+:)?c>/giu)].map(cellMatch => {
      const attributes = cellMatch[1] ?? ''
      const reference = /\br="([A-Z]+)\d+"/u.exec(attributes)?.[1] ?? ''
      const raw = /<(?:[\w.-]+:)?v>([\s\S]*?)<\/(?:[\w.-]+:)?v>/iu.exec(cellMatch[2] ?? '')?.[1] ?? /<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/iu.exec(cellMatch[2] ?? '')?.[1] ?? ''
      const value = /\bt="s"/u.test(attributes) ? sharedStrings[Number(raw)] ?? '' : decodeXml(raw)
      return { reference, value }
    })
    rowsByNumber.set(rowNumber, Object.fromEntries(cells.filter(cell => cell.reference).map(cell => [cell.reference, cell.value])))
  }
  let mergeExpansions = 0
  for (const match of sheetXml.matchAll(/<(?:[\w.-]+:)?mergeCell\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*\/?\s*>/giu)) {
    const [, startColumn, startRowText, endColumn, endRowText] = match
    if (!startColumn || !startRowText || startColumn !== endColumn) continue
    const startRow = xlsxRowNumber(startRowText, 0), endRow = xlsxRowNumber(endRowText, 0)
    if (endRow <= startRow) continue
    mergeExpansions += endRow - startRow
    if (mergeExpansions > MAX_XLSX_MERGE_EXPANSIONS) throw new Error(`XLSX 合并单元格展开量超过上限（${MAX_XLSX_MERGE_EXPANSIONS}）`)
    const value = rowsByNumber.get(startRow)?.[startColumn]
    if (value === undefined || value === '') continue
    lastRow = Math.max(lastRow, endRow)
    for (let rowNumber = startRow + 1; rowNumber <= endRow; rowNumber += 1) {
      const row = rowsByNumber.get(rowNumber) ?? {}
      row[startColumn] ??= value
      rowsByNumber.set(rowNumber, row)
    }
  }
  return { format: 'xlsx', rows: Array.from({ length: lastRow }, (_, index) => rowsByNumber.get(index + 1) ?? {}) }
}

async function parseDocx(bytes: Uint8Array): Promise<ParsedDocumentFacts> {
  const entries = preflightZip(bytes)
  const budget = { used: 0 }
  const inflatedEntries = new Map<string, Uint8Array>()
  const file = {
    exists(name: string) { return entries.has(name) },
    async read(name: string, encoding?: string) {
      const entry = entries.get(name)
      if (!entry) throw new Error(`DOCX 条目不存在：${name}`)
      let value = inflatedEntries.get(name)
      if (!value) {
        value = readZipEntry(bytes, entry, budget)
        inflatedEntries.set(name, value)
      }
      return encoding ? new TextDecoder(encoding, { fatal: true }).decode(value) : value
    },
    write() { throw new Error('DOCX 只读解析不支持写入') },
    toArrayBuffer() { throw new Error('DOCX 只读解析不支持导出') },
  }
  const result = await extractRawText({ file } as unknown as Parameters<typeof extractRawText>[0])
  if (Buffer.byteLength(result.value, 'utf8') > MAX_EXTRACTED_TEXT) throw new Error('DOCX 提取文本超过解析上限')
  return { format: 'docx', text: result.value, ...(result.messages.length ? { parserMessages: result.messages.map(message => message.message) } : {}) }
}

export async function parseDocumentFacts(input: { name: string; mimeType: string; body: Uint8Array }): Promise<ParsedDocumentFacts> {
  if (input.body.byteLength > MAX_DOCUMENT_INPUT_BYTES) throw new Error('文档输入超过解析上限')
  const name = input.name.toLowerCase()
  const mime = input.mimeType.toLowerCase()
  if (mime.includes('json') || name.endsWith('.json')) {
    if (input.body.byteLength > MAX_EXTRACTED_TEXT) throw new Error('文档内容超过解析上限')
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
  if (mime.includes('csv') || name.endsWith('.csv')) {
    if (input.body.byteLength > MAX_EXTRACTED_TEXT) throw new Error('文档内容超过解析上限')
    return parseCsvRows(new TextDecoder().decode(input.body))
  }
  if (mime.startsWith('text/') || /\.(txt|md)$/u.test(name)) {
    if (input.body.byteLength > MAX_EXTRACTED_TEXT) throw new Error('文档内容超过解析上限')
    return parseDelimitedText(new TextDecoder().decode(input.body))
  }
  if (mime.includes('spreadsheet') || mime.includes('excel') || /\.(xlsx|xls)$/u.test(name)) return parseXlsx(input.body)
  if (mime.includes('wordprocessingml') || mime.includes('msword') || /\.(docx|doc)$/u.test(name)) {
    return parseDocx(input.body)
  }
  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    const loadingTask = getDocument({ data: Uint8Array.from(input.body), verbosity: VerbosityLevel.ERRORS })
    let doc: Awaited<typeof loadingTask.promise> | undefined
    try {
      doc = await loadingTask.promise
      if (doc.numPages > MAX_PDF_PAGES) throw new Error('PDF 页数超过解析上限')
      let text = ''
      let bytesUsed = 0
      let exhausted = false
      let cancelDocument = false
      for (let pageNumber = 1; pageNumber <= doc.numPages && !exhausted; pageNumber += 1) {
        const page = await doc.getPage(pageNumber)
        const reader = page.streamTextContent({ includeMarkedContent: false, disableNormalization: false }).getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            for (const item of value.items) {
              if (!('str' in item)) continue
              const fragment = item.str + (item.hasEOL ? '\n' : '')
              const remaining = MAX_EXTRACTED_TEXT - bytesUsed
              if (remaining <= 0) { exhausted = true; break }
              const encoded = Buffer.from(fragment, 'utf8')
              if (encoded.byteLength > remaining) {
                const truncated = truncateUtf8ToByteLength(fragment, remaining)
                text += truncated
                bytesUsed += Buffer.byteLength(truncated, 'utf8')
                exhausted = true
                break
              }
              text += fragment
              bytesUsed += encoded.byteLength
            }
            if (exhausted) {
              await reader.cancel('PDF extracted text limit reached')
              cancelDocument = true
              break
            }
          }
        } finally {
          reader.releaseLock()
          page.cleanup()
        }
        if (cancelDocument) break
        if (!exhausted && pageNumber < doc.numPages) {
          const separator = '\n\n'
          if (bytesUsed + separator.length <= MAX_EXTRACTED_TEXT) { text += separator; bytesUsed += separator.length }
          else exhausted = true
        }
      }
      return { format: 'pdf', text, pages: doc.numPages }
    } finally {
      if (doc) await doc.destroy()
      else await loadingTask.destroy()
    }
  }
  throw new DocumentParseError({ code: 'unsupported_format', message: '当前文件格式不支持结构化解析；图片 OCR、扫描 PDF 和 AI/EPS 需要配置外部解析器', manualAction: 'asset.facts.confirm' })
}
