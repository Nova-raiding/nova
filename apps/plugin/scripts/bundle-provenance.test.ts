import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { writeBundleProvenance, verifyBundleProvenance } from './bundle-provenance.mjs'

describe('offline bundle provenance', () => {
  it('binds a bundle to source metadata and every payload file, then rejects tampering or omissions', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'plugin-provenance-'))
    try {
      mkdirSync(resolve(root, '.codex-plugin'))
      writeFileSync(resolve(root, '.codex-plugin/plugin.json'), JSON.stringify({ id: 'merchant-marketing', version: '1.2.3' }))
      writeFileSync(resolve(root, 'bridge.mjs'), 'original')
      const cleanStatus = JSON.stringify({ source_dirty: true, ci_test_certificate: false, ready_to_install: false })
      writeFileSync(resolve(root, 'bundle-status.json'), cleanStatus)
      const record = writeBundleProvenance(root, { plugin: 'merchant-marketing', version: '1.2.3',
        platform: process.platform, architecture: process.arch, gitCommit: 'a'.repeat(40), sourceDirty: true })
      expect(record.files.map(file => file.path)).toEqual(['.codex-plugin/plugin.json', 'bridge.mjs', 'bundle-status.json'])
      expect(verifyBundleProvenance(root)).toMatchObject({ ok: true, source_dirty: true, authenticity_verified: false })

      writeFileSync(resolve(root, 'bundle-status.json'), JSON.stringify({ source_dirty: true, ci_test_certificate: false, ready_to_install: true }))
      expect(verifyBundleProvenance(root).errors).toContain('bundle status conflicts with provenance or deliverability')
      writeFileSync(resolve(root, 'bundle-status.json'), cleanStatus)

      writeFileSync(resolve(root, 'bridge.mjs'), 'modified')
      expect(verifyBundleProvenance(root)).toMatchObject({ ok: false, errors: ['file digest differs: bridge.mjs'] })
      writeFileSync(resolve(root, 'bridge.mjs'), 'original')
      writeFileSync(resolve(root, 'unlisted.mjs'), 'extra')
      expect(verifyBundleProvenance(root).errors).toContain('bundle provenance file inventory differs')

      const manifest = JSON.parse(readFileSync(resolve(root, 'bundle-provenance.json'), 'utf8'))
      manifest.files[0].path = '../outside'
      writeFileSync(resolve(root, 'bundle-provenance.json'), JSON.stringify(manifest))
      expect(verifyBundleProvenance(root).errors).toContain('bundle provenance file paths are invalid or unsorted')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
