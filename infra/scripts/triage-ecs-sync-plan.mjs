#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isAllowlistedReviewSource } from './ecs-review-source-policy.mjs'
import { PROTECTED_OPS_PATHS, STRUCTURE_REVIEW_PATHS } from './ecs-review-structure.mjs'

const TRIAGE_SCHEMA_VERSION = 1
const PLAN_HEADER = 'status\tlocal_sha256\tremote_sha256\tpath'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sorted = values => [...values].sort((a, b) => a.localeCompare(b))
const countByTopLevel = paths => {
  const counts = {}
  for (const path of paths) {
    const key = path.includes('/') ? path.slice(0, path.indexOf('/')) : path
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

const fail = message => { throw new Error(message) }

const readRegular = path => {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate input is not a regular file: ${path}`)
  return readFileSync(path)
}

const parseIdentity = bytes => {
  const identity = {}
  for (const line of bytes.toString('utf8').trim().split(/\r?\n/u)) {
    const index = line.indexOf('=')
    if (index < 1 || line.indexOf('=', index + 1) !== -1) fail('candidate identity is malformed')
    const key = line.slice(0, index)
    if (identity[key] !== undefined) fail(`candidate identity has duplicate key: ${key}`)
    identity[key] = line.slice(index + 1)
  }
  return identity
}

const readJson = (path, required) => {
  if (!existsSync(path)) {
    if (required) fail(`required review report is missing: ${path}`)
    return null
  }
  try { return JSON.parse(readRegular(path).toString('utf8')) } catch { fail(`review report is not valid JSON: ${path}`) }
}

const assertBoundIdentity = (report, identity, label) => {
  if (!report || report.candidate_git_sha !== identity.git_sha || report.candidate_source_sha256 !== identity.source_sha256 || report.candidate_sync_plan_sha256 !== identity.sync_plan_sha256) {
    fail(`${label} is not bound to candidate identity`)
  }
}

const parsePlan = (bundle, identity) => {
  const manifestBytes = readRegular(join(bundle, 'files.txt'))
  const planBytes = readRegular(join(bundle, 'sync-plan.tsv'))
  if (identity.comparison_manifest_sha256 !== `sha256:${sha256(manifestBytes)}` || identity.sync_plan_sha256 !== `sha256:${sha256(planBytes)}`) {
    fail('candidate identity does not bind files.txt and sync-plan.tsv')
  }
  const manifest = manifestBytes.toString('utf8').split(/\r?\n/u).filter(Boolean)
  if (new Set(manifest).size !== manifest.length) fail('candidate file manifest contains duplicate paths')
  const manifestSet = new Set(manifest)
  const lines = planBytes.toString('utf8').trimEnd().split(/\r?\n/u)
  if (lines.shift() !== PLAN_HEADER) fail('unrecognized sync-plan format')
  const rows = new Map()
  for (const line of lines) {
    const columns = line.split('\t')
    if (columns.length !== 4 || columns.some(column => !column)) fail('sync-plan row has invalid column count or empty field')
    const [status, localSha, remoteSha, path] = columns
    if (!['same', 'review_required', 'missing_remote'].includes(status) || !/^[0-9a-f]{64}$/u.test(localSha)) fail(`invalid sync-plan row for ${path}`)
    if (status === 'missing_remote' ? remoteSha !== '-' : !/^[0-9a-f]{64}$/u.test(remoteSha)) fail(`invalid remote digest in sync-plan for ${path}`)
    if ((status === 'same' && localSha !== remoteSha) || (status === 'review_required' && localSha === remoteSha)) fail(`sync-plan status does not match digests for ${path}`)
    if (rows.has(path) || !manifestSet.has(path)) fail(`duplicate or unbound sync-plan path: ${path}`)
    rows.set(path, { status, local_sha256: localSha, remote_sha256: remoteSha })
  }
  return { manifest, rows }
}

const validateReviewReports = (bundle, identity, rows) => {
  const reviewPaths = sorted([...rows].filter(([, row]) => row.status === 'review_required').map(([path]) => path))
  const reviewSet = new Set(reviewPaths)
  const structureReport = readJson(join(bundle, 'remote-structure-review.json'), true)
  assertBoundIdentity(structureReport, identity, 'remote structure review')
  if (structureReport.remote_read_only !== true || structureReport.raw_remote_bytes_persisted !== false) fail('remote structure review is not read-only/sanitized')
  const structural = structureReport.structural_review
  const protectedReview = structureReport.protected_onsite_review
  if (!Array.isArray(structural) || !Array.isArray(protectedReview)) fail('remote structure review has invalid classifications')
  const structuralPaths = structural.map(item => item?.path)
  const protectedPaths = protectedReview.map(item => item?.path)
  if (new Set(structuralPaths).size !== structuralPaths.length || new Set(protectedPaths).size !== protectedPaths.length) fail('remote structure review contains duplicate paths')
  const structureSet = new Set(STRUCTURE_REVIEW_PATHS)
  const protectedSet = new Set(PROTECTED_OPS_PATHS)
  for (const path of structuralPaths) {
    if (!reviewSet.has(path) || !structureSet.has(path)) fail(`unbound structural review path: ${path}`)
    const item = structural.find(entry => entry.path === path)
    const row = rows.get(path)
    if (item.candidate_sha256 !== row.local_sha256 || item.remote_sha256 !== row.remote_sha256) fail(`structural review digest is not sync-plan bound: ${path}`)
    if (typeof item.structure_matches !== 'boolean') fail(`structural review has no match decision: ${path}`)
  }
  for (const path of protectedPaths) {
    if (!reviewSet.has(path) || !protectedSet.has(path)) fail(`unbound protected review path: ${path}`)
    const item = protectedReview.find(entry => entry.path === path)
    const row = rows.get(path)
    if (item.remote_sha256_bound_to_plan !== row.remote_sha256) fail(`protected review digest is not sync-plan bound: ${path}`)
    if (item.status !== 'protected_onsite_review_required') fail(`protected review status is not fail-closed: ${path}`)
  }
  const acquisition = readJson(join(bundle, 'remote-review-source', 'review-acquisition.json'), true)
  assertBoundIdentity(acquisition, identity, 'source review acquisition')
  if (acquisition.remote_read_only !== true || !Array.isArray(acquisition.files) || !Array.isArray(acquisition.refused_paths)) fail('source review acquisition has invalid shape')
  const fetchedPaths = acquisition.files.map(item => item?.path)
  const refusedPaths = acquisition.refused_paths
  if (new Set(fetchedPaths).size !== fetchedPaths.length || new Set(refusedPaths).size !== refusedPaths.length) fail('source review acquisition contains duplicate paths')
  for (const path of fetchedPaths) {
    if (!reviewSet.has(path) || !isAllowlistedReviewSource(path)) fail(`unbound fetched source review path: ${path}`)
    const row = rows.get(path)
    const file = acquisition.files.find(item => item.path === path)
    if (!file || file.remote_sha256 !== row.remote_sha256 || !/^[0-9a-f]{64}$/u.test(file.remote_sha256)) fail(`fetched source review digest is not sync-plan bound: ${path}`)
    const sourcePath = join(bundle, 'remote-review-source', path)
    const sourceBytes = readRegular(sourcePath)
    if (!Number.isSafeInteger(file.bytes) || file.bytes !== sourceBytes.length || sha256(sourceBytes) !== file.remote_sha256) fail(`fetched source review bytes do not match bound digest: ${path}`)
  }
  for (const path of refusedPaths) if (!reviewSet.has(path)) fail(`unbound refused review path: ${path}`)
  const partition = new Set([...fetchedPaths, ...structuralPaths, ...protectedPaths])
  const partitionComplete = partition.size === reviewPaths.length && reviewPaths.every(path => partition.has(path)) && refusedPaths.length === structuralPaths.length + protectedPaths.length && refusedPaths.every(path => new Set([...structuralPaths, ...protectedPaths]).has(path))
  return {
    reviewPaths,
    fetchedPaths: sorted(fetchedPaths),
    refusedPaths: sorted(refusedPaths),
    structural: structural.map(item => ({ path: item.path, structure_matches: item.structure_matches })).sort((a, b) => a.path.localeCompare(b.path)),
    protectedPaths: sorted(protectedPaths),
    partitionComplete,
  }
}

const validateCandidateNewConfirmation = (bundle, identity, rows) => {
  const missingPaths = sorted([...rows].filter(([, row]) => row.status === 'missing_remote').map(([path]) => path))
  const path = join(bundle, 'candidate-new-file-confirmation.json')
  if (!missingPaths.length) return { required: false, approved: true, count: 0, paths: [] }
  if (!existsSync(path)) return { required: true, approved: false, count: 0, paths: [] }
  const report = readJson(path, true)
  assertBoundIdentity(report, identity, 'candidate-new file confirmation')
  if (report.schema_version !== 'ecs-candidate-new-file-confirmation/1' || report.remote_read_only !== true || report.approved !== true || report.remote_alias !== '101' || report.remote_root !== '/opt/merchant-deploy' || report.candidate_archive_sha256 !== identity.source_sha256 || !Array.isArray(report.files)) fail('candidate-new file confirmation is not a read-only approved report')
  const files = report.files
  if (report.count !== files.length || files.length !== missingPaths.length || new Set(files.map(item => item?.path)).size !== files.length) fail('candidate-new file confirmation does not cover every missing_remote path')
  let archiveMembers
  try {
    const inventory = JSON.parse(execFileSync('python3', ['-c', `import hashlib,json,pathlib,sys,tarfile
max_members, max_file, max_total = 250000, 2 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024
seen, total, result = set(), 0, []
with tarfile.open(sys.argv[1], "r:") as archive:
    members = archive.getmembers()
    if not members or len(members) > max_members: raise SystemExit('invalid candidate archive member count')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or not member.name or '..' in path.parts or '\\n' in member.name or '\\r' in member.name:
            raise SystemExit('unsafe candidate archive member path')
        normalized = path.as_posix().rstrip('/')
        if not normalized or normalized in seen: raise SystemExit('duplicate candidate archive path')
        seen.add(normalized)
        if not (member.isdir() or member.isfile()): raise SystemExit('candidate archive contains a link or special file')
        if member.mode & 0o7000: raise SystemExit('candidate archive contains privileged mode bits')
        if member.isfile():
            if member.size > max_file: raise SystemExit('candidate archive member is too large')
            total += member.size
            if total > max_total: raise SystemExit('candidate archive expands beyond release limit')
            content = archive.extractfile(member).read()
            result.append({"path":member.name,"regular":True,"sha256":hashlib.sha256(content).hexdigest()})
        else:
            result.append({"path":member.name,"regular":False,"sha256":None})
print(json.dumps(result))`, join(bundle, 'candidate-source.tar')], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
    if (new Set(inventory.map(item => item.path)).size !== inventory.length) fail('candidate source archive contains duplicate members')
    archiveMembers = new Map(inventory.map(item => [item.path, item]))
  } catch { fail('candidate source archive cannot be verified') }
  for (const item of files) {
    const row = rows.get(item.path)
    if (!/^[A-Za-z0-9._/-]+$/u.test(item?.path ?? '') || item.path.startsWith('/') || item.path.split('/').some(part => part === '..' || part === '.' || part === '') || !row || row.status !== 'missing_remote' || !/^[0-9a-f]{64}$/u.test(item.local_sha256 ?? '') || item.local_sha256 !== row.local_sha256 || item.archive_member !== true || item.archive_sha256 !== row.local_sha256 || archiveMembers.get(item.path)?.regular !== true || archiveMembers.get(item.path)?.sha256 !== row.local_sha256 || item.remote_state !== 'absent') fail(`candidate-new file confirmation is not sync-plan bound: ${item.path}`)
  }
  return { required: true, approved: true, count: files.length, paths: sorted(files.map(item => item.path)) }
}

const validateProtectedOnsiteReview = (bundle, identity, rows) => {
  const path = join(bundle, 'protected-onsite-structure-review.json')
  if (!existsSync(path)) return { required: true, approved: false, count: 0, paths: [] }
  const report = readJson(path, true)
  assertBoundIdentity(report, identity, 'protected onsite review')
  if (report.remote_read_only !== true || report.raw_remote_bytes_persisted !== false || report.remote_alias !== '101' || report.remote_root !== '/opt/merchant-deploy' || report.approved !== false || report.review_scope !== 'hash_and_metadata_only' || report.semantic_review_completed !== false || !Array.isArray(report.protected_onsite_review)) fail('protected onsite review is not an explicitly unapproved hash-only report')
  const expected = sorted([...rows].filter(([path, row]) => row.status === 'review_required' && PROTECTED_OPS_PATHS.includes(path)).map(([path]) => path))
  const entries = report.protected_onsite_review
  if (report.protected_onsite_review_count !== entries.length || entries.length !== expected.length || new Set(entries.map(item => item?.path)).size !== entries.length) fail('protected onsite review does not cover the exact protected path set')
  for (const item of entries) {
    const row = rows.get(item.path)
    if (!row || !PROTECTED_OPS_PATHS.includes(item.path) || item.remote_sha256_bound_to_plan !== row.remote_sha256 || item.remote_sha256_observed !== row.remote_sha256 || item.digest_match !== true || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^\d{4,5}$/u.test(item.mode ?? '') || !Number.isSafeInteger(item.uid) || item.uid < 0 || !Number.isSafeInteger(item.gid) || item.gid < 0 || item.status !== 'reviewed_protected_structure') fail(`protected onsite review is not sync-plan bound: ${item.path}`)
  }
  // Metadata and structural observations do not approve deployment wiring.
  // Keep the semantic onsite review gate closed until its contract is implemented.
  return { required: true, approved: false, count: entries.length, paths: expected }
}

// A hash/metadata observation cannot establish what the host revision was.
// Semantic review is only consumable when a separate, candidate-bound
// attestation names the trusted host baseline.  In particular, the candidate
// identity alone is not a trusted remote identity and must never be treated as
// a merge base.
const validateProtectedSemanticDiff = (bundle, identity, rows) => {
  const expected = sorted([...rows].filter(([path, row]) => row.status === 'review_required' && PROTECTED_OPS_PATHS.includes(path)).map(([path]) => path))
  const path = join(bundle, 'protected-onsite-semantic-diff.json')
  if (!existsSync(path)) return {
    required: true,
    approved: false,
    status: 'not_run',
    reason: 'trusted_remote_identity_unavailable',
    count: 0,
    paths: [],
  }
  const report = readJson(path, true)
  assertBoundIdentity(report, identity, 'protected semantic diff')
  if (report.schema_version !== 'ecs-protected-onsite-semantic-diff/1' || report.remote_read_only !== true || report.raw_remote_bytes_persisted !== false || report.remote_alias !== '101' || report.remote_root !== '/opt/merchant-deploy') fail('protected semantic diff is not a candidate-bound read-only report')
  const baseline = report.trusted_remote_baseline
  if (baseline?.status !== 'verified' || typeof baseline.revision !== 'string' || !/^[A-Za-z0-9._:@/-]{1,256}$/u.test(baseline.revision) || !/^[0-9a-f]{64}$/u.test(baseline.manifest_sha256 ?? '') || baseline.attestation_verified !== true) {
    if (baseline?.status === 'classification_only' && typeof baseline.revision === 'string' && /^[A-Za-z0-9._:@/-]{1,256}$/u.test(baseline.revision) && /^[0-9a-f]{64}$/u.test(baseline.manifest_sha256 ?? '') && baseline.attestation_verified === false) {
      return { required: true, approved: false, status: 'classification_only', reason: 'trusted_remote_identity_bound_for_classification_only', count: 0, paths: [] }
    }
    return { required: true, approved: false, status: 'not_run', reason: 'trusted_remote_identity_unverified', count: 0, paths: [] }
  }
  if (report.semantic_review_completed !== true || report.approved !== true || !Array.isArray(report.files) || report.files.length !== expected.length || new Set(report.files.map(item => item?.path)).size !== report.files.length) fail('protected semantic diff is not an approved complete report')
  for (const item of report.files) {
    const row = rows.get(item.path)
    if (!row || !PROTECTED_OPS_PATHS.includes(item.path) || item.candidate_sha256 !== row.local_sha256 || item.remote_sha256 !== row.remote_sha256 || item.decision !== 'approved' || item.semantic_diff_status !== 'completed') fail(`protected semantic diff is not sync-plan bound: ${item.path}`)
  }
  return { required: true, approved: true, status: 'completed', reason: 'trusted_remote_identity_and_owner_review', count: report.files.length, paths: expected }
}

export function buildTriageReport(bundleInput) {
  const bundle = resolve(bundleInput)
  const identity = parseIdentity(readRegular(join(bundle, 'candidate-identity.txt')))
  if (!/^[0-9a-f]{40}$/u.test(identity.git_sha ?? '')) fail('candidate identity has invalid git_sha')
  const archive = readRegular(join(bundle, 'candidate-source.tar'))
  if (identity.source_sha256 !== `sha256:${sha256(archive)}`) fail('candidate identity does not bind candidate-source.tar')
  const { rows } = parsePlan(bundle, identity)
  const byStatus = { same: [], review_required: [], missing_remote: [] }
  for (const [path, row] of rows) byStatus[row.status].push(path)
  for (const paths of Object.values(byStatus)) paths.sort((a, b) => a.localeCompare(b))
  const review = validateReviewReports(bundle, identity, rows)
  const candidateNew = validateCandidateNewConfirmation(bundle, identity, rows)
  const protectedOnsite = validateProtectedOnsiteReview(bundle, identity, rows)
  const protectedSemanticDiff = validateProtectedSemanticDiff(bundle, identity, rows)
  // Hash/metadata review records what was observed; the gate is approved only
  // when the separately attested semantic diff covers the same exact set.
  const protectedGate = { ...protectedOnsite, approved: protectedSemanticDiff.approved && protectedOnsite.count === protectedSemanticDiff.count }
  const structuralMatches = review.structural.filter(item => item.structure_matches).map(item => item.path)
  const structuralMismatches = review.structural.filter(item => !item.structure_matches).map(item => item.path)
  const blockers = [
    'review_required_three_way_merge_not_approved',
    'candidate_runtime_evidence_not_present',
  ]
  if (!protectedGate.approved) blockers.splice(1, 0, 'protected_onsite_review_not_approved')
  if (!candidateNew.approved) blockers.splice(2, 0, 'missing_remote_new_file_confirmation_not_approved')
  return {
    schema_version: `ecs-sync-plan-triage/${TRIAGE_SCHEMA_VERSION}`,
    candidate: {
      bundle: dirname(bundle).endsWith('deployment-candidates') ? bundle.slice(bundle.lastIndexOf('/') + 1) : bundle.split('/').pop(),
      git_sha: identity.git_sha,
      source_sha256: identity.source_sha256,
      comparison_manifest_sha256: identity.comparison_manifest_sha256,
      sync_plan_sha256: identity.sync_plan_sha256,
    },
    counts: Object.fromEntries(Object.entries(byStatus).map(([status, paths]) => [status, paths.length])),
    review_required: {
      count: review.reviewPaths.length,
      top_level_counts: countByTopLevel(review.reviewPaths),
      paths: review.reviewPaths,
      source_fetched_count: review.fetchedPaths.length,
      source_fetched_paths: review.fetchedPaths,
      structural_count: review.structural.length,
      structural_match_count: structuralMatches.length,
      structural_mismatch_count: structuralMismatches.length,
      structural_match_paths: structuralMatches,
      structural_mismatch_paths: structuralMismatches,
      protected_onsite_count: review.protectedPaths.length,
      protected_onsite_paths: review.protectedPaths,
      partition_complete: review.partitionComplete,
    },
    missing_remote: {
      count: byStatus.missing_remote.length,
      top_level_counts: countByTopLevel(byStatus.missing_remote),
      paths: byStatus.missing_remote,
      confirmation: candidateNew,
    },
    protected_onsite: { ...protectedGate, semantic_diff: protectedSemanticDiff },
    three_way_merge_checklist: {
      local_prepare: [
        `Review and merge ${review.fetchedPaths.length} fetched source files in a separate checkout; preserve remote-only wiring.`,
        `Review ${review.structural.length} sanitized structural summaries (${structuralMismatches.length} mismatches; ${structuralMatches.length} structural matches).`,
        `Validate all ${byStatus.missing_remote.length} missing_remote paths as candidate-new files from the bound archive before isolated staging.`,
        'Run typecheck, release gates, targeted tests, and candidate-bound preflight against the merged checkout.',
      ],
      onsite_required: [
        `Review ${review.protectedPaths.length} protected paths in the 101 protected host context; return only sanitized structural decisions.`,
        'Perform a three-way merge against the exact remote bytes and trusted remote revision; never overwrite the remote checkout wholesale.',
        'Capture candidate-bound runtime, database/RLS, model relay, MCP, ChatGPT host, canary, rollback, and signed evidence before cutover.',
      ],
      pass_conditions: [
        'All review_required files have recorded three-way decisions with no unresolved conflicts.',
        'All protected onsite paths have approved sanitized structural review bound to this identity.',
        'All missing_remote files are confirmed candidate-new and present in the verified archive.',
        'Candidate staging toolchain, release checkout, images, evidence, and runtime /releasez identity match every identity field.',
      ],
    },
    decision: 'NO_GO',
    blockers,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundle = process.argv[2]
  if (!bundle || process.argv.length !== 3) {
    console.error('usage: node infra/scripts/triage-ecs-sync-plan.mjs <candidate-bundle-dir>')
    process.exit(2)
  }
  try { process.stdout.write(`${JSON.stringify(buildTriageReport(bundle), null, 2)}\n`) } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
