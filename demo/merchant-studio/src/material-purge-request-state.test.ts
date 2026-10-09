import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { materialPurgeRequestOutcome } from './material-purge-request-state.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const recycleBin = app.slice(
  app.indexOf('export function MaterialRecycleBinWorkspace'),
  app.indexOf('export function MaterialLibraryWorkspace'),
)

describe('early asset purge request recovery state', () => {
  it('keeps the confirmation and reason when all requests fail', () => {
    expect(materialPurgeRequestOutcome(['asset-1'], [])).toEqual({
      selectedIds: ['asset-1'],
      closeDialog: false,
      clearConfirmation: false,
      clearReason: false,
    })
  })

  it('keeps failed items selected after a partial success and closes only when all succeeded', () => {
    expect(materialPurgeRequestOutcome(['asset-1', 'asset-2'], ['asset-1'])).toEqual({
      selectedIds: ['asset-2'],
      closeDialog: false,
      clearConfirmation: false,
      clearReason: false,
    })
    expect(materialPurgeRequestOutcome(['asset-1'], ['asset-1'])).toEqual({
      selectedIds: [],
      closeDialog: true,
      clearConfirmation: true,
      clearReason: true,
    })
  })

  it('keeps request failures inside the open confirmation dialog', () => {
    expect(recycleBin).toContain('if (outcome.closeDialog) setPurgeDialogOpen(false)')
    expect(recycleBin).toContain('setSelectedIds(outcome.selectedIds)')
    expect(recycleBin).toContain('if (outcome.clearConfirmation) setPurgeConfirmation(\'\')')
    expect(recycleBin).toContain('{recycleError && <p role="alert">{recycleError}</p>}')
    expect(recycleBin).toContain('!purgeDialogOpen && <p role="alert">{recycleError}</p>')
  })
})
