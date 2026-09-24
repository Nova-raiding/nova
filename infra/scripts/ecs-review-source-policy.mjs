const SOURCE_ROOTS = Object.freeze([
  'apps/api/src/', 'apps/ops-console/src/', 'apps/worker/src/', 'apps/plugin/src/',
  'demo/merchant-studio/src/', 'demo/merchant-studio/scripts/', 'packages/ai/src/',
  'packages/persistence/src/', 'packages/workers/src/', 'packages/connectors/src/',
  'packages/application/src/', 'packages/domain/src/', 'packages/security/src/',
  'packages/storage/src/', 'scripts/',
])
const REVIEWABLE_BUILD_CONFIGS = new Set(['apps/ops-console/vite.config.ts'])

export function isAllowlistedReviewSource(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9._/-]+$/u.test(path) || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.' || part === '')) return false
  const sourceExtension = /\.(?:[cm]?[jt]sx?|d\.mts|d\.cts|sql)$/u.test(path)
  if ((!SOURCE_ROOTS.some((root) => path.startsWith(root)) && !REVIEWABLE_BUILD_CONFIGS.has(path)) || !sourceExtension) return false
  if (/(?:^|\/)(?:\.env(?:\.|$)|.*(?:secret|credential|private[-_]?key|token|production[-_]?config).*)/iu.test(path)) return false
  return true
}
