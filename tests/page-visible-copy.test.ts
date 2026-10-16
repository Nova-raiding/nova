import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps built-in Demo branding out of frontend, API and plugin copy without changing runtime mode identifiers', () => {
  const violations: string[] = []
  const visitDirectory = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'fixtures') visitDirectory(file); continue }
      if (file.endsWith('.html')) {
        if (/演示|\bdemo\b/iu.test(readFileSync(file, 'utf8'))) violations.push(`${file}: built-in HTML copy`)
        continue
      }
      if (!/\.(?:tsx?|mjs)$/u.test(file) || /\.(?:test|spec)\./u.test(file)) continue
      const source = readFileSync(file, 'utf8')
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const visitNode = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          // Import paths name source modules rather than user-facing content.
          if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) return
          const text = node.text.trim()
          // Runtime mode remains authoritative; changing it would alter the environment contract.
          if (text !== 'demo' && (/演示/u.test(text) || /\bdemo\b/iu.test(text))) {
            const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
            violations.push(`${file}:${line + 1}: ${text.slice(0, 100)}`)
          }
        }
        ts.forEachChild(node, visitNode)
      }
      visitNode(ast)
    }
  }
  for (const directory of ['apps/ops-console/src', 'demo/merchant-studio/src', 'apps/api/src', 'apps/plugin/mcp', '.codex-marketplace/plugins/merchant-marketing/mcp', 'apps/plugin/ui', '.codex-marketplace/plugins/merchant-marketing/ui']) visitDirectory(resolve(directory))
  for (const file of ['apps/ops-console/index.html', 'demo/merchant-studio/index.html']) {
    if (/演示|\bdemo\b/iu.test(readFileSync(resolve(file), 'utf8'))) violations.push(`${file}: built-in HTML copy`)
  }
  expect(violations).toEqual([])
}, 15_000)
