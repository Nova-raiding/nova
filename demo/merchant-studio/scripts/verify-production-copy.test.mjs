import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertProductionOutputClean, forbiddenMerchantCopy, findForbiddenMerchantCopy } from './verify-production-copy.mjs'

test('detects both retired manual-operations messages in generated JavaScript', () => {
  assert.deepEqual(findForbiddenMerchantCopy(forbiddenMerchantCopy.join('\n')),[...forbiddenMerchantCopy])
})

test('accepts JavaScript that contains no retired manual-operations copy', () => {
  assert.deepEqual(findForbiddenMerchantCopy('const status = "服务状态正常";'), [])
})

test('recursively scans production JavaScript and reports a forbidden copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'merchant-copy-guard-'))
  try {
    const assets = join(directory, 'assets')
    await mkdir(assets)
    await writeFile(join(directory, 'index.js'), 'const ok = true;')
    await writeFile(join(assets, 'chunk.js'), `const notice = ${JSON.stringify(forbiddenMerchantCopy[0])};`)

    await assert.rejects(
      assertProductionOutputClean(directory),
      error => error instanceof Error && error.message.includes(forbiddenMerchantCopy[0]) && error.message.includes('chunk.js'),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
