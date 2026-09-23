import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const forbiddenMerchantCopy = Object.freeze([
  '当前为人工运营模式，六平台店铺由运营人员在官方后台处理；首页不会自动发现、授权或同步店铺。',
  '人工运营模式不执行平台店铺发现；商品来自商家知识库与人工导入。',
])

export function findForbiddenMerchantCopy(source) {
  return forbiddenMerchantCopy.filter(copy => source.includes(copy))
}

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listJavaScriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : []
  }))
  return nested.flat().sort()
}

export async function scanProductionOutput(distDirectory) {
  const files = await listJavaScriptFiles(distDirectory)
  if (files.length === 0) throw new Error(`No JavaScript files found under ${distDirectory}`)

  const violations = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const copy of findForbiddenMerchantCopy(source)) violations.push({ file, copy })
  }
  return { scannedFiles: files.length, violations }
}

export async function assertProductionOutputClean(distDirectory) {
  const result = await scanProductionOutput(distDirectory)
  if (result.violations.length > 0) {
    const details = result.violations.map(({ file, copy }) => `${file}: ${copy}`).join('\n')
    throw new Error(`Forbidden manual-operations copy found in Merchant Studio production output:\n${details}`)
  }
  return result.scannedFiles
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const distDirectory = resolve(dirname(scriptPath), '..', 'dist')
  try {
    const scannedFiles = await assertProductionOutputClean(distDirectory)
    console.log(`Merchant Studio production copy guard passed (${scannedFiles} JavaScript files scanned).`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
