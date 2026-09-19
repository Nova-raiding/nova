/**
 * The single CSV cell encoder for every user-downloadable export.
 *
 * This is deliberately one function rather than one per service. Three
 * near-identical copies previously lived in `server.ts`,
 * `ops/finance-search-service.ts` and `ops/audit-center-service.ts`; the
 * `server.ts` copy checked only `/^[=+\-@]/` and so missed the tab (0x09) and
 * carriage-return (0x0D) prefixes that the other two covered. Divergent
 * hand-copies are what produced that gap, so the rule now lives in one place.
 *
 * Two things have to be true of an exported cell:
 *
 *  1. It is always quoted, and embedded quotes are doubled, so a value can
 *     never break out of its field or start a new record.
 *  2. A leading character that a spreadsheet may read as the start of a
 *     formula is prefixed with `'`, which Excel/LibreOffice/Sheets treat as
 *     literal text. OWASP's CSV-injection guidance lists `=`, `+`, `-`, `@`,
 *     tab (0x09) and carriage return (0x0D) as formula-triggering leading
 *     characters; all six are covered here.
 *
 * Known residual (documented, not fixed here): OWASP lists line feed (0x0A)
 * and the full-width variants `＝ ＋ － ＠` in the same set. Neither is
 * covered by this encoder nor by the two implementations it replaces.
 */
export function csvCell(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? '' : String(value)
  const safe = /^[=+@\-\t\r]/u.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
