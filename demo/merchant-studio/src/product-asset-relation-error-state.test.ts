import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

/** The relation dialog's own source, from its definition to the next component. */
const dialog = app.slice(
  app.indexOf('function ProductAssetRelationDialog'),
  app.indexOf('type CatalogStore = {'),
)

describe('product asset relation dialog separates read failures from write failures', () => {
  // Regression: the dialog kept one `error` state for both reads and binding
  // writes. Any failed bind/unbind therefore replaced the successfully read
  // relation with 「关系读取失败：…」 and its retry only re-read, so the merchant
  // lost the valid binding list and was told the read had failed when the write
  // had.
  it('keeps a failed binding write out of the read-error state', () => {
    const mutate = dialog.slice(dialog.indexOf('const mutateBinding = ('), dialog.indexOf('return (\n    <DialogFrame'))
    expect(mutate).toContain('setSaveError(describeApiError(cause))')
    expect(mutate).not.toContain('setError(')
    // The read path still owns `error`.
    expect(dialog).toContain('if (active) setError(describeApiError(cause))')
  })

  it('keeps the last successfully read relation visible after a write refusal', () => {
    expect(dialog).toContain('{!loading && !error && product && (')
    expect(dialog).toContain('data-testid="product-asset-relation-write-error"')
    expect(dialog).toContain('关系写入失败：{saveError}')
    // The offered recovery reads the relations again instead of pretending the
    // failed write can be retried blindly.
    expect(dialog).toContain('重新读取关系')
    expect(dialog).toContain('onClick={reload}')
  })
})
