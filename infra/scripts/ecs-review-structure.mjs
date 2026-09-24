import { createHash } from 'node:crypto'

export const STRUCTURE_REVIEW_PATHS = Object.freeze([
  'package.json', 'package-lock.json', 'demo/merchant-studio/package.json', 'demo/merchant-studio/package-lock.json', 'apps/ops-console/package.json',
  'infra/docker/api.Dockerfile', 'infra/docker/worker.Dockerfile', 'infra/docker/pilot-gateway-https.Dockerfile', 'infra/docker/ops-console.Dockerfile', 'infra/docker/ui.Dockerfile',
  'infra/nginx/pilot-gateway-https.conf', 'infra/nginx/merchant-studio.conf', 'infra/nginx/ops-console.conf', 'infra/nginx/pilot-gateway.conf',
  'apps/ops-console/src/styles.css', 'demo/merchant-studio/src/capability.css', 'demo/merchant-studio/src/styles.css',
  'tests/ecs-pilot-api-replica-parity.test.ts', 'tests/object-storage-evidence-gate.test.ts', 'tests/model-relay-contract.test.ts', 'tests/production-config-gate.test.ts', 'tests/rendered-production-config-gate.test.ts', 'tests/production-evidence-gate.test.ts', 'tests/release-manifest-gate.test.ts', 'tests/release-manifest.test.ts', 'tests/local-compose-ops-ui.test.ts', 'tests/codex-app-host-evidence-gate.test.ts', 'tests/operations-scripts.test.ts', 'tests/ecs-compose-published-ports.test.ts', 'demo/merchant-studio/api.test.ts', 'demo/merchant-studio/notification-center.test.ts', 'demo/merchant-studio/image-generation-desktop.spec.js',
  'tests/object-storage-evidence-gate.ts', 'packages/contracts/src/ops/feature-flags.ts', 'tests/production-evidence-gate.ts', 'tests/release-manifest-gate.ts', 'tests/test-suite-isolation.ts', '.github/workflows/ci.yml', 'AGENTS.md', 'tests/codex-app-host-evidence-gate.ts', 'demo/merchant-studio/README.md', 'docs/chatgpt-host-canary-runbook.md',
])

export const PROTECTED_OPS_PATHS = Object.freeze([
  '.env.example', 'release-metadata.json',
  'infra/local/docker-compose.yml', 'infra/local/docker-compose.ecs-pilot.yml', 'infra/local/docker-compose.ecs-production-api-private.yml', 'infra/local/docker-compose.ecs-production-migration.yml', 'infra/local/docker-compose.ecs-pilot-release.yml', 'infra/local/ecs-production-compose.layers',
  'infra/scripts/render-ecs-production-compose.sh', 'infra/scripts/validate-ecs-production-compose.mjs', 'infra/scripts/validate-production-config.sh', 'infra/scripts/validate-production-config-yaml.rb', 'infra/scripts/rotate-alipay-secrets.sh',
  'apps/api/src/aliyun-ecs-role-credentials.ts',
  'infra/scripts/apply-migrations.sh', 'infra/scripts/verify-runtime-db-role.sh', 'infra/scripts/generate-container-source-manifest.mjs', 'infra/local/ensure-app-role.sql', 'infra/scripts/pilot-compose-preflight.sh', 'infra/scripts/stage-verified-ecs-release.sh', 'infra/scripts/deploy-verified-ecs-compose.sh', 'infra/scripts/ecs-compose-published-ports.mjs', 'infra/scripts/ecs-compose-published-ports.d.mts', 'infra/scripts/deploy-preflight-ecs.sh', 'infra/scripts/deploy-preflight.sh',
])

const digest = data => createHash('sha256').update(data).digest('hex')
const count = (text, regex) => [...text.matchAll(regex)].length
const safeDependencyNames = names => names.filter(name => /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u.test(name)).sort()

function summarizeJson(path, text) {
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json_shape')
  if (path.endsWith('package-lock.json')) {
    const packages = value.packages && typeof value.packages === 'object' ? value.packages : {}
    const names = Object.keys(packages['']?.dependencies ?? {})
    return { kind: 'dependency_lock', package_records: Object.keys(packages).length, root_dependency_names: safeDependencyNames(names), omitted_non_package_names: names.length - safeDependencyNames(names).length }
  }
  const dependencyNames = [...new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(key => Object.keys(value[key] ?? {})))]
  const safeNames = safeDependencyNames(dependencyNames)
  return { kind: 'package_manifest', dependency_names: safeNames, omitted_non_package_names: dependencyNames.length - safeNames.length, script_count: Object.keys(value.scripts ?? {}).length }
}

function summarizeDockerfile(text) {
  const instructionCounts = {}
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z]+)\b/u)
    if (match && !line.trimStart().startsWith('#')) instructionCounts[match[1].toUpperCase()] = (instructionCounts[match[1].toUpperCase()] ?? 0) + 1
  }
  return { kind: 'dockerfile_structure', instruction_counts: instructionCounts, stage_count: instructionCounts.FROM ?? 0 }
}

function summarizeNginx(text) {
  const directiveCounts = {}
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed === '{' || trimmed === '}') continue
    const directive = trimmed.match(/^([A-Za-z_]+)\b/u)?.[1]?.toLowerCase()
    if (directive) directiveCounts[directive] = (directiveCounts[directive] ?? 0) + 1
  }
  return { kind: 'nginx_structure', server_blocks: directiveCounts.server ?? 0, location_blocks: directiveCounts.location ?? 0, upstream_blocks: directiveCounts.upstream ?? 0, directive_counts: directiveCounts }
}

function summarizeCss(text) {
  const selectors = new Set()
  const properties = new Set()
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = match[1].trim()
    if (selector && !selector.startsWith('@')) selectors.add(selector)
    for (const declaration of match[2].split(';')) {
      const property = declaration.match(/^\s*([--A-Za-z][\w-]*)\s*:/u)?.[1]
      if (property) properties.add(property.toLowerCase())
    }
  }
  return { kind: 'css_structure', selector_count: selectors.size, property_names: [...properties].sort() }
}

function summarizeTest(text) {
  return {
    kind: 'test_structure',
    import_count: count(text, /^\s*import\b/gmu),
    describe_count: count(text, /\bdescribe\s*\(/gu),
    test_case_count: count(text, /\b(?:it|test)\s*(?:\.each\s*\([^\n]*?\)\s*)?\(/gu),
    declaration_counts: {
      functions: count(text, /\bfunction\s+[A-Za-z_$][\w$]*/gu),
      classes: count(text, /\bclass\s+[A-Za-z_$][\w$]*/gu),
    },
  }
}

function summarizeMarkdown(text) {
  const headingCounts = {}
  for (const match of text.matchAll(/^\s*(#{1,6})\s+[^\r\n]*$/gmu)) headingCounts[match[1].length] = (headingCounts[match[1].length] ?? 0) + 1
  return { kind: 'document_structure', heading_counts_by_level: headingCounts, fenced_code_block_count: Math.floor(count(text, /^\s*```/gmu) / 2), line_count: text.split(/\r?\n/u).length }
}

function summarizeYaml(text) {
  const keyCounts = {}
  for (const match of text.matchAll(/^\s{0,12}([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/gmu)) keyCounts[match[1]] = (keyCounts[match[1]] ?? 0) + 1
  return { kind: 'workflow_structure', key_counts: keyCounts, job_count: keyCounts.jobs ?? 0, step_count: count(text, /^\s+-\s+(?:name|uses|run):/gmu), env_block_count: keyCounts.env ?? 0, secret_reference_count: count(text, /\$\{\{\s*secrets\./giu) }
}

function summarizeSource(text) {
  return {
    kind: 'source_structure',
    import_count: count(text, /^\s*import\b/gmu),
    export_count: count(text, /^\s*export\b/gmu),
    function_count: count(text, /\bfunction\s+[A-Za-z_$][\w$]*/gu),
    class_count: count(text, /\bclass\s+[A-Za-z_$][\w$]*/gu),
    interface_count: count(text, /\binterface\s+[A-Za-z_$][\w$]*/gu),
    test_case_count: count(text, /\b(?:it|test)\s*(?:\.each\s*\([^\n]*?\)\s*)?\(/gu),
  }
}

export function summarizeReviewBytes(path, bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    let summary
    if (/\.json$/u.test(path)) summary = summarizeJson(path, text)
    else if (/\.Dockerfile$/u.test(path)) summary = summarizeDockerfile(text)
    else if (/\.conf$/u.test(path)) summary = summarizeNginx(text)
    else if (/\.css$/u.test(path)) summary = summarizeCss(text)
    else if (/\.(?:test\.ts|test\.js|spec\.js)$/u.test(path)) summary = summarizeTest(text)
    else if (/\.(?:md)$/u.test(path)) summary = summarizeMarkdown(text)
    else if (/\.ya?ml$/u.test(path)) summary = summarizeYaml(text)
    else summary = summarizeSource(text)
    return { status: 'reviewed', sha256: digest(bytes), bytes: bytes.byteLength, summary }
  } catch {
    return { status: 'unable_to_safely_parse', sha256: digest(bytes), bytes: bytes.byteLength, reason_code: 'STRUCTURE_PARSE_REJECTED' }
  }
}
